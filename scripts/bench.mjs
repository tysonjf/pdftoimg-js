// Times example.pdf through a built copy of the package: `pnpm build` then
// `node scripts/bench.mjs [dist-dir]`. Each case runs once to warm up (pdf.js
// loading, the JIT, the render pool starting) and then five times.
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { pathToFileURL } from "node:url";

const distDir = resolve(process.argv[2] ?? "dist");
const { pdfToImg } = await import(
  pathToFileURL(resolve(distDir, "index.mjs")).href
);
const bytes = new Uint8Array(
  await readFile(new URL("../example/example.pdf", import.meta.url)),
);

console.log(
  `${distDir} on Node ${process.version}, ${availableParallelism()} CPUs`,
);
const cold = performance.now();
await pdfToImg(bytes, { pages: 1, returnType: "bytes" });
console.log(
  `cold start, first page: ${(performance.now() - cold).toFixed(0)} ms`,
);

async function time(label, options, runs = 5) {
  await pdfToImg(bytes, options);
  const times = [];
  let size = 0;
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const out = await pdfToImg(bytes, options);
    times.push(performance.now() - start);
    size = [out]
      .flat()
      .reduce((sum, image) => sum + (image.bytes?.length ?? image.length), 0);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  console.log(
    `${label.padEnd(46)} median ${median.toFixed(0).padStart(5)} ms  ` +
      `best ${times[0].toFixed(0).padStart(5)} ms  ${(size / 1024).toFixed(0).padStart(6)} KB`,
  );
}

await time("first page, scale 2, PNG bytes", {
  pages: 1,
  scale: 2,
  returnType: "bytes",
});
await time("first page, scale 2, JPEG bytes", {
  pages: 1,
  scale: 2,
  imgType: "jpg",
  returnType: "bytes",
});
await time("14 pages, scale 1, PNG bytes, threads: 0", {
  returnType: "bytes",
  threads: 0,
});
await time("14 pages, scale 1, PNG bytes", { returnType: "bytes" });
await time("14 pages, scale 1, PNG data URLs", {});
await time(
  "14 pages, scale 2, PNG bytes",
  { scale: 2, returnType: "bytes" },
  3,
);
await time("14 pages, scale 1, JPEG bytes", {
  imgType: "jpg",
  returnType: "bytes",
});
console.log(`rss now ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
