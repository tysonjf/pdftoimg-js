import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { pathToFileURL } from "node:url";

export type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: Promise<PdfjsLib> | undefined;

/**
 * pdf.js for Node, with its worker registered on the main thread.
 *
 * Node has no Web Worker, so pdf.js falls back to importing "./pdf.worker.mjs"
 * relative to pdf.mjs the first time a document loads. That works from
 * node_modules and breaks the moment a bundler flattens the package into one
 * file (Convex's esbuild does this for "use node" actions): the relative path
 * then points at nothing and pdf.js throws "Setting up fake worker failed".
 *
 * Importing the worker module here makes the bundler carry it along. The
 * module registers itself on `globalThis.pdfjsWorker`, which pdf.js checks
 * before it ever touches the file system.
 */
export function loadPdfjs(): Promise<PdfjsLib> {
  pdfjs ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ]).then(
    ([lib]) => lib,
    (error) => {
      pdfjs = undefined;
      // pdf.js (5.4 through 6.4) only warns here when @napi-rs/canvas is
      // missing ("Cannot polyfill `DOMMatrix`"); the missing canvas surfaces
      // later, from the canvas factory in renderPage. This is a safety net
      // for anything else that stops pdf.js or its worker from evaluating,
      // such as a pdf.js that touches DOMMatrix at import time.
      throw describeCanvasFailure(error);
    },
  );
  return pdfjs;
}

let pdfjsDir: string | null | undefined;

/**
 * The directory pdfjs-dist is installed in, or null when it cannot be found
 * on disk (a bundle that carries pdf.js inside itself, for example).
 *
 * Resolution starts from this module's own location, which inside a bundle is
 * the bundle's location, so a pdfjs-dist installed next to the bundle is
 * found. The working directory is the fallback, which is where earlier
 * versions always looked.
 */
export function pdfjsDistDir(): string | null {
  if (pdfjsDir !== undefined) {
    return pdfjsDir;
  }
  const bases = [
    import.meta.url,
    pathToFileURL(join(process.cwd(), "package.json")).href,
  ];
  for (const base of bases) {
    try {
      pdfjsDir = dirname(
        createRequire(base).resolve("pdfjs-dist/package.json"),
      );
      return pdfjsDir;
    } catch {
      // try the next base
    }
  }
  pdfjsDir = null;
  return pdfjsDir;
}

export interface PdfjsAssetParams {
  cMapUrl?: string;
  cMapPacked?: boolean;
  standardFontDataUrl?: string;
  wasmUrl?: string;
  iccUrl?: string;
}

/**
 * Where pdf.js should read its CMaps, the 14 standard fonts, the WASM image
 * decoders and the ICC profiles from.
 *
 * pdf.js's Node factories read these with fs.readFile, so each "URL" is a
 * directory on disk with a trailing separator. When pdfjs-dist is not on disk
 * nothing is passed: PDFs with embedded fonts render as usual, and pdf.js warns
 * once for each non-embedded standard font it cannot load. Callers can always
 * override any of these through `documentOptions`.
 */
export function pdfjsAssetParams(): PdfjsAssetParams {
  const dir = pdfjsDistDir();
  if (!dir) {
    return {};
  }
  const subdir = (name: string) => `${join(dir, name)}${sep}`;
  return {
    cMapUrl: subdir("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: subdir("standard_fonts"),
    wasmUrl: subdir("wasm"),
    iccUrl: subdir("iccs"),
  };
}

const CANVAS_PACKAGE = "@napi-rs/canvas";

/**
 * pdf.js draws through @napi-rs/canvas in Node and loads it with a plain
 * `require`. When that fails the raw error ("Cannot find module
 * '@napi-rs/canvas'", "DOMMatrix is not defined") says nothing about what to
 * do, so say it here. Any other error, pdf.js's own "Invalid canvas size"
 * included, is passed through untouched.
 */
export function describeCanvasFailure(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new Error(String(error));
  }
  if (!isMissingCanvas(error)) {
    return error;
  }
  const { message } = error;
  return new Error(
    `pdftoimg-js could not create a canvas: ${message}\n` +
      `Rendering in Node needs ${CANVAS_PACKAGE} (a prebuilt native module). ` +
      `Install it in your project, and if your code is bundled keep it out of the bundle ` +
      `and installed on the server. On Convex that means listing it in convex.json ` +
      `under node.externalPackages.`,
  );
}

function isMissingCanvas(error: Error): boolean {
  const { code } = error as NodeJS.ErrnoException;
  if (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND") {
    return error.message.includes(CANVAS_PACKAGE);
  }
  // @napi-rs/canvas is installed but its prebuilt binary for this platform
  // is not (an optional dependency the install skipped).
  if (/(Cannot find|Failed to load) native binding/.test(error.message)) {
    return true;
  }
  // The DOM classes pdf.js polyfills from the canvas package.
  return (
    error instanceof ReferenceError &&
    /\b(DOMMatrix|ImageData|Path2D) is not defined/.test(error.message)
  );
}
