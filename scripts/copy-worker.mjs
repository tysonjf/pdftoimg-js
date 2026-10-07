// Ships pdf.js's worker in dist/, exported as "pdftoimg-js/worker", so a
// browser app can serve the worker of the exact pdf.js version the browser
// entry runs (the legacy build) instead of loading it from cdnjs.
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const worker = require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const out = new URL("../dist/pdf.worker.min.mjs", import.meta.url);

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
await copyFile(worker, out);
