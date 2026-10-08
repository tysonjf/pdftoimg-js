import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dataUrlToPng,
  decodePng,
  hasInk,
  installedPackageDir,
  require,
} from "./helpers";

// The browser entry in a real Chromium: the bundle a web app would ship,
// the worker served from this package's copy of pdf.js, and the pixels
// read back here in Node. Needs Playwright's Chromium:
// `pnpm exec playwright install chromium` once.

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = "/pdf.worker.min.mjs";
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
};

// Same box as helvetica.pdf's checks in node-render.test.ts.
const TEXT_BOX = { x: 20, y: 36, w: 90, h: 26 };
const SQUARE = { x: 165, y: 65 };
const CORNER = { x: 2, y: 2 };

let server: Server;
let browser: Browser;
let page: Page;

async function render(src: string, options: Record<string, unknown>) {
  return page.evaluate(
    async ({ src, options }) => {
      const out = await window.pdfToImg(src, options);
      // Typed arrays do not come back from evaluate; data URLs do.
      const plain = (image: unknown) =>
        typeof image === "string"
          ? image
          : {
              ...(image as object),
              bytes: Array.from((image as { bytes: Uint8Array }).bytes),
            };
      return Array.isArray(out) ? out.map(plain) : plain(out);
    },
    { src, options: { workerSrc: WORKER, ...options } },
  );
}

declare global {
  interface Window {
    pdfToImg: (src: unknown, options: unknown) => Promise<unknown>;
    preloadWorker: (workerSrc?: string) => Promise<void>;
    workersStarted: number;
    ready: boolean;
  }
}

beforeAll(async () => {
  const outfile = join(
    installedPackageDir("pdfjs-dist"),
    "..",
    ".cache",
    "pdftoimg-js",
    "browser.test.js",
  );
  await build({
    entryPoints: [join(here, "..", "src", "browser.ts")],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    outfile,
    logLevel: "silent",
  });
  const files: Record<string, string | Buffer> = {
    "/": `<!doctype html><script type="module">
      // Count the Web Workers pdf.js starts.
      window.workersStarted = 0;
      const RealWorker = Worker;
      window.Worker = class extends RealWorker {
        constructor(...args) { super(...args); window.workersStarted++; }
      };
      const lib = await import("/bundle.js");
      Object.assign(window, lib, { ready: true });
    </script>`,
    "/bundle.js": await readFile(outfile),
    [WORKER]: await readFile(
      require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
    ),
    "/helvetica.pdf": await readFile(join(here, "fixtures", "helvetica.pdf")),
    "/example.pdf": await readFile(join(here, "..", "example", "example.pdf")),
  };
  files["/another-worker.mjs"] = files[WORKER];
  server = createServer((request, response) => {
    const body = files[request.url ?? ""];
    if (body === undefined) {
      response.writeHead(404).end();
      return;
    }
    response
      .writeHead(200, {
        "content-type": types[extname(request.url ?? "")] ?? "text/html",
      })
      .end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on("pageerror", (error) => console.error("page error:", error));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => window.ready);
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

describe("pdfToImg in the browser", () => {
  it("renders non-embedded Helvetica on a white page, with the square", async () => {
    const dataUrl = (await render("/helvetica.pdf", { pages: 1 })) as string;
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect([px.width, px.height]).toEqual([200, 100]);
    expect(px.at(CORNER.x, CORNER.y)).toEqual([255, 255, 255, 255]);
    expect(px.at(SQUARE.x, SQUARE.y)).toEqual([0, 0, 255, 255]);
    expect(hasInk(px, TEXT_BOX)).toBe(true);
  });

  it("keeps the page transparent with background rgba(0,0,0,0)", async () => {
    const dataUrl = (await render("/helvetica.pdf", {
      pages: 1,
      background: "rgba(0,0,0,0)",
    })) as string;
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect(px.at(CORNER.x, CORNER.y)[3]).toBe(0);
    expect(px.at(SQUARE.x, SQUARE.y)).toEqual([0, 0, 255, 255]);
    expect(hasInk(px, TEXT_BOX)).toBe(true);
  });

  it("returns bytes with the pixel size and page number", async () => {
    const image = (await render("/helvetica.pdf", {
      pages: 1,
      scale: 2,
      returnType: "bytes",
    })) as {
      pageNumber: number;
      width: number;
      height: number;
      mime: string;
      bytes: number[];
    };
    expect(image.pageNumber).toBe(1);
    expect([image.width, image.height]).toEqual([400, 200]);
    expect(image.mime).toBe("image/png");
    const px = await decodePng(Buffer.from(image.bytes));
    expect(px.at(SQUARE.x * 2, SQUARE.y * 2)).toEqual([0, 0, 255, 255]);
  });

  it("renders several pages of a document at once, in order", async () => {
    const urls = (await render("/example.pdf", {
      pages: [3, 1],
      scale: 0.25,
    })) as string[];
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      const px = await decodePng(dataUrlToPng(url));
      expect(px.width).toBeGreaterThan(100);
    }
  });

  it("starts one worker for all of those calls, and another for another workerSrc", async () => {
    expect(await page.evaluate(() => window.workersStarted)).toBe(1);
    await page.evaluate(() => window.preloadWorker("/another-worker.mjs"));
    expect(await page.evaluate(() => window.workersStarted)).toBe(2);
    const dataUrl = (await render("/helvetica.pdf", {
      pages: 1,
      workerSrc: "/another-worker.mjs",
    })) as string;
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(await page.evaluate(() => window.workersStarted)).toBe(2);
  });
});
