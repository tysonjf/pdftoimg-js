"use node";
// A stand-in for a Convex "use node" action. The bundling test compiles this
// file the way the Convex CLI compiles convex/*.ts, then runs the result from
// an unrelated working directory with only the external packages on disk.
import { readFile, writeFile } from "node:fs/promises";
import { pdfToImg } from "../../src/index";

const [pdfPath, outPath, background] = process.argv.slice(2);

const bytes = new Uint8Array(await readFile(pdfPath));
const dataUrl = await pdfToImg(bytes, {
  pages: "firstPage",
  scale: 1,
  background: background || undefined,
});
await writeFile(outPath, Buffer.from(dataUrl.split(",")[1], "base64"));
console.log(JSON.stringify({ ok: true, cwd: process.cwd() }));
