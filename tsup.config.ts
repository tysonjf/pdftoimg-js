import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    platform: "node",
    dts: true,
    splitting: false,
    clean: true,
    minify: true,
    shims: true,
  },
  {
    entry: ["src/cli.ts"],
    format: ["cjs"],
    platform: "node",
    splitting: false,
    clean: true,
    minify: true,
    shims: true,
  },
  {
    // The render pool's worker thread, loaded by dist/index.{js,mjs} from the
    // file next to them. ESM only: a worker_threads Worker runs an .mjs file
    // whichever way the main thread was loaded.
    entry: ["src/render-worker.ts"],
    format: ["esm"],
    platform: "node",
    splitting: false,
    clean: true,
    minify: true,
    shims: true,
  },
  {
    entry: ["src/browser.ts"],
    format: ["cjs", "esm"],
    platform: "browser",
    splitting: false,
    dts: true,
    clean: true,
    minify: true,
    shims: true,
  },
]);
