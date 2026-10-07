import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import {
  decodePng,
  hasInk,
  installedOptionalDependencies,
  installedPackageDir,
} from "./helpers";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "fixtures", "convex-action.ts");
const helveticaPdf = join(here, "fixtures", "helvetica.pdf");
const examplePdf = join(here, "..", "example", "example.pdf");

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(
    tempDirs.map((d) => rm(d, { recursive: true, force: true })),
  );
});

/**
 * Bundles the fixture the way the Convex CLI bundles a "use node" action
 * (convex@1.45, src/bundler/index.ts): one ESM bundle with code splitting,
 * everything inlined except the packages named in convex.json's
 * node.externalPackages, which Convex installs on the server instead.
 *
 * The fake server is a temp dir with the bundle in `code/` and the external
 * packages symlinked into `node_modules/` beside it, each with the optional
 * dependencies npm would install along with it (for @napi-rs/canvas, its
 * prebuilt binary for this platform) unless the test places those itself.
 * The bundle is then run from the OS temp dir, so nothing may depend on
 * process.cwd(), and with --preserve-symlinks: Node otherwise follows each
 * link to its real path under pnpm's store and resolves the package's own
 * dependencies from there, so a package missing from the fake server would
 * still be found.
 */
async function bundleLikeConvex(
  externalPackages: string[],
  { installOnServer = externalPackages } = {},
) {
  const server = await mkdtemp(join(tmpdir(), "pdftoimg-convex-"));
  tempDirs.push(server);
  const outdir = join(server, "code");

  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "esnext",
    outdir,
    conditions: ["convex", "module"],
    external: externalPackages,
    splitting: true,
    chunkNames: "_deps/[hash]",
    treeShaking: true,
    minifySyntax: true,
    minifyIdentifiers: true,
    keepNames: true,
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });

  const link = async (name: string, dir: string) => {
    const at = join(server, "node_modules", name);
    await mkdir(dirname(at), { recursive: true });
    await symlink(dir, at, "dir");
  };
  for (const name of installOnServer) {
    await link(name, installedPackageDir(name));
    for (const dep of installedOptionalDependencies(name)) {
      if (!externalPackages.includes(dep.name)) {
        await link(dep.name, dep.dir);
      }
    }
  }

  return {
    server,
    async render(pdf: string, background?: string) {
      const out = join(server, "page.png");
      const args = [
        "--preserve-symlinks",
        join(outdir, "convex-action.js"),
        pdf,
        out,
      ];
      if (background) args.push(background);
      const { stdout, stderr } = await run(process.execPath, args, {
        cwd: tmpdir(),
        env: { ...process.env, NODE_PATH: "" },
      });
      const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
      const warnings = (stdout + stderr)
        .split("\n")
        .filter((l) => l.startsWith("Warning:"));
      return { result, warnings, png: await decodePng(await readFile(out)) };
    },
  };
}

describe("bundled the way Convex bundles a 'use node' action", () => {
  it("renders with only @napi-rs/canvas external (pdf.js inlined in the bundle)", async () => {
    const { render } = await bundleLikeConvex(["@napi-rs/canvas"]);
    const { result, png } = await render(examplePdf);
    expect(result.ok).toBe(true);
    expect(result.cwd).toBe(tmpdir());
    expect(png.width).toBeGreaterThan(100);
  });

  it("warns about standard fonts when pdf.js is inlined, but still renders", async () => {
    const { render } = await bundleLikeConvex(["@napi-rs/canvas"]);
    const { result, warnings, png } = await render(
      helveticaPdf,
      "rgba(0,0,0,0)",
    );
    expect(result.ok).toBe(true);
    expect([png.width, png.height]).toEqual([200, 100]);
    expect(png.at(2, 2)[3]).toBe(0);
    expect(png.at(165, 65)).toEqual([0, 0, 255, 255]);
    expect(
      warnings.some((w) => /standard font|standardFontDataUrl/i.test(w)),
    ).toBe(true);
  });

  it("renders standard fonts when pdfjs-dist is external too (the recommended setup)", async () => {
    const { render } = await bundleLikeConvex([
      "@napi-rs/canvas",
      "pdfjs-dist",
    ]);
    const { result, warnings, png } = await render(helveticaPdf);
    expect(result.ok).toBe(true);
    expect(warnings).toEqual([]);
    expect(hasInk(png, { x: 20, y: 36, w: 90, h: 26 })).toBe(true);
    expect(png.at(2, 2)).toEqual([255, 255, 255, 255]);
  });

  it("explains what to do when @napi-rs/canvas is missing on the server", async () => {
    // Listed as external, but never installed where the bundle runs: the
    // misconfiguration a Convex user hits when externalPackages is incomplete.
    const { render } = await bundleLikeConvex(["@napi-rs/canvas"], {
      installOnServer: [],
    });
    const failure = await render(examplePdf).then(
      () => null,
      (error: Error & { stderr?: string }) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.stderr).toMatch(/needs @napi-rs\/canvas/);
    expect(failure!.stderr).toMatch(/externalPackages/);
  });

  it("finds the canvas only through the server, not through pnpm's store", async () => {
    // An external pdfjs-dist with no canvas beside it. Its real directory
    // under node_modules/.pnpm has a canvas next to it, so this passes only
    // if the run resolves from the fake server alone.
    const { render } = await bundleLikeConvex(
      ["@napi-rs/canvas", "pdfjs-dist"],
      { installOnServer: ["pdfjs-dist"] },
    );
    const failure = await render(helveticaPdf).then(
      () => null,
      (error: Error & { stderr?: string }) => error,
    );
    expect(failure).not.toBeNull();
    expect(failure!.stderr).toMatch(/needs @napi-rs\/canvas/);
  });
});
