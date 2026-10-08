// Times the browser entry in headless Chromium: `node scripts/bench-browser.mjs`.
// Needs Playwright with its Chromium, installed locally or globally
// (`npm i -g playwright && npx playwright install chromium`); esbuild comes
// with the dev dependencies. The first page of example.pdf is rendered the
// way a web app would, with the worker served from this package's build.
import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";

const require = createRequire(import.meta.url);
const { build } = require("esbuild");
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  const globalRoot = execSync("npm root -g").toString().trim();
  ({ chromium } = createRequire(join(globalRoot, "package.json"))(
    "playwright",
  ));
}

const root = new URL("../", import.meta.url);
const out = join(tmpdir(), "pdftoimg-js-bench-browser");
await build({
  entryPoints: [new URL("src/browser.ts", root).pathname],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outfile: join(out, "bundle.js"),
  logLevel: "warning",
});

const files = {
  "/": `<!doctype html><script type="module">
    import { pdfToImg, preloadWorker } from "./bundle.js";
    Object.assign(window, { pdfToImg, preloadWorker, ready: true });
  </script>`,
  "/bundle.js": join(out, "bundle.js"),
  "/pdf.worker.min.mjs":
    require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs"),
  "/example.pdf": new URL("example/example.pdf", root).pathname,
};
const types = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".pdf": "application/pdf",
};
const server = createServer(async (request, response) => {
  const file = files[request.url];
  if (!file) {
    response.writeHead(404).end();
    return;
  }
  const body = request.url === "/" ? file : await readFile(file);
  response
    .writeHead(200, { "content-type": types[extname(file)] ?? "text/html" })
    .end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (error) => console.log("page error:", error.message));
await page.goto(origin);
await page.waitForFunction(() => window.ready);
console.log(`Chromium ${browser.version()} (headless, software rendering)`);

const first = await page.evaluate(async () => {
  const bytes = new Uint8Array(
    await (await fetch("/example.pdf")).arrayBuffer(),
  );
  const start = performance.now();
  await window.pdfToImg(bytes, { pages: 1, workerSrc: "/pdf.worker.min.mjs" });
  return performance.now() - start;
});
console.log(
  `first call (pdf.js and its worker loading): ${first.toFixed(0)} ms`,
);

async function time(label, options, runs = 7) {
  const result = await page.evaluate(
    async ({ options, runs }) => {
      const bytes = new Uint8Array(
        await (await fetch("/example.pdf")).arrayBuffer(),
      );
      const opts = { workerSrc: "/pdf.worker.min.mjs", ...options };
      await window.pdfToImg(bytes, opts);
      const times = [];
      let size = 0;
      for (let i = 0; i < runs; i++) {
        const start = performance.now();
        const out = await window.pdfToImg(bytes, opts);
        times.push(performance.now() - start);
        size = [out]
          .flat()
          .reduce(
            (sum, image) => sum + (image.bytes?.length ?? image.length),
            0,
          );
      }
      times.sort((a, b) => a - b);
      return {
        median: times[Math.floor(times.length / 2)],
        best: times[0],
        size,
      };
    },
    { options, runs },
  );
  console.log(
    `${label.padEnd(40)} median ${result.median.toFixed(0).padStart(5)} ms  ` +
      `best ${result.best.toFixed(0).padStart(5)} ms  ${(result.size / 1024).toFixed(0).padStart(6)} KB`,
  );
}

await time("first page, scale 2, PNG data URL", { pages: 1, scale: 2 });
await time("first page, scale 2, PNG bytes", {
  pages: 1,
  scale: 2,
  returnType: "bytes",
});
await time("first page, scale 2, JPEG data URL", {
  pages: 1,
  scale: 2,
  imgType: "jpg",
});
await time("first page, scale 2, transparent PNG", {
  pages: 1,
  scale: 2,
  background: "rgba(0,0,0,0)",
});
await time(
  "pages 1-4, scale 1, PNG data URLs",
  { pages: { startPage: 1, endPage: 4 } },
  5,
);

await browser.close();
server.close();
