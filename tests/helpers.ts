import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const require = createRequire(import.meta.url);

export function dataUrlToPng(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:image/png;base64,") || comma === -1) {
    throw new Error(`not a PNG data URL: ${dataUrl.slice(0, 40)}`);
  }
  return Buffer.from(dataUrl.slice(comma + 1), "base64");
}

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8ClampedArray;
  at(x: number, y: number): [number, number, number, number];
}

/** Decodes a PNG by drawing it onto a canvas; @napi-rs/canvas is already a dependency. */
export async function decodePng(png: Buffer): Promise<Pixels> {
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(
    0,
    0,
    image.width,
    image.height,
  );
  return {
    width,
    height,
    data,
    at(x, y) {
      const i = (y * width + x) * 4;
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    },
  };
}

/** True when some pixel in the box is darker than mid grey and opaque. */
export function hasInk(
  px: Pixels,
  box: { x: number; y: number; w: number; h: number },
): boolean {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const [r, g, b, a] = px.at(x, y);
      if (a > 128 && (r + g + b) / 3 < 128) {
        return true;
      }
    }
  }
  return false;
}

/** Real directory of an installed package, for symlinking into a fake server layout. */
export function installedPackageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/**
 * The optional dependencies of an installed package that are installed here,
 * by name and real directory. For @napi-rs/canvas these are its prebuilt
 * platform binaries, which npm installs beside it for the current platform.
 */
export function installedOptionalDependencies(
  name: string,
): { name: string; dir: string }[] {
  const dir = installedPackageDir(name);
  const fromPackage = createRequire(join(dir, "package.json"));
  const manifest = fromPackage("./package.json") as {
    optionalDependencies?: Record<string, string>;
  };
  return Object.keys(manifest.optionalDependencies ?? {}).flatMap((dep) => {
    try {
      return [
        { name: dep, dir: dirname(fromPackage.resolve(`${dep}/package.json`)) },
      ];
    } catch {
      return [];
    }
  });
}

/**
 * Builds src/render-worker.ts the way `pnpm build` does, for tests that run
 * from src/ and would otherwise find no worker file next to src/pool.ts.
 * The bundle lands under node_modules/.cache so its imports of pdfjs-dist
 * resolve from this package's node_modules.
 */
export async function buildRenderWorker(): Promise<URL> {
  const { build } = await import("esbuild");
  const outfile = join(
    installedPackageDir("pdfjs-dist"),
    "..",
    ".cache",
    "pdftoimg-js",
    "render-worker.test.mjs",
  );
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/render-worker.ts", import.meta.url)),
    ],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    logLevel: "silent",
  });
  return pathToFileURL(outfile);
}
