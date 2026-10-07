> **Version 2 Has Arrived! 🎉**  
> This release is still in beta, so we welcome your feedback and feature requests.  
> If you encounter any bugs, please report them by opening an issue on our [GitHub repository](https://github.com/tysonjf/pdftoimg-js/issues).

# PDFtoIMG-JS

**PDFtoIMG-JS** is a powerful JavaScript library for converting **PDF file/files into images** (PNG or JPG).
It supports both **Node.js** and **browser environments**, making it ideal for a wide range of use cases — including integration with popular frameworks such as **React**, **Next.js**, **Vue**, and more.

## ✨ Features

- 📚 Supports **single** and **multiple** PDFs.
- 🎯 Choose specific **pages** (`all`, `firstPage`, `lastPage`, page numbers, or ranges like `1..3`).
- 🎨 Output images as **PNG** or **JPG** formats.
- 🔥 Compatible with **React**, **Next.js**, **Vue**, etc.
- 🛠 Fine control over **scale** and **output options**.
- 💻 Browser runtime automatically uses **HTML5 Canvas** rendering.
- 🧹 CLI ready for quick batch processing in **Node.js**.

## 📦 Installation

```bash
npm install pdftoimg-js
```

Node 20.16 or newer (22.3 or newer on the 22 line). In Node the pages are drawn
with [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas), a prebuilt
native canvas that needs no system libraries; it is an optional dependency of
both this package and `pdfjs-dist`, so a normal install brings it along.

In Node, pages are rasterised one after another and encoded in parallel. pdf.js
has no real worker there, so rendering pages concurrently only interleaves them
and raises peak memory (14 A4 pages: 3.8 s concurrent, 3.1 s sequential), while
`@napi-rs/canvas` encodes PNG and JPEG on a separate thread, so each page's
encode starts as soon as it is drawn.

## 🛠 Basic Usage

#### 🚀 Example (Node.js Script)

```ts
import { pdfToImg } from "pdftoimg-js";

const images = await pdfToImg("example.pdf", {
  pages: "firstPage",
  imgType: "jpg",
  scale: 2,
  background: "white",
});

console.log(images); // => Base64 encoded JPG image
```

#### 📝 Example (Browser)

```ts
import { pdfToImg } from "pdftoimg-js/browser";

const fileInput = document.getElementById("pdfInput");

fileInput.addEventListener("change", async (e) => {
  const file = e.target.files[0];
  const images = await pdfToImg(URL.createObjectURL(file), {
    maxWidth: 1000,
    maxHeight: 1000,
    // Set scaleForBrowserSupport: true to automatically scale to 4096x4096
    // Setting maxWidth and maxHeight will override scaleForBrowserSupport
    // scaleForBrowserSupport: true,
  });

  images.forEach((imgSrc) => {
    const img = document.createElement("img");
    img.src = imgSrc;
    document.body.appendChild(img);
  });
});
```

## 📖 API Reference

### `pdfToImg(src, options?)`

Convert PDF(s) to images.

| Parameter | Type                                                             | Description                                                                                 |
| :-------- | :--------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| `src`     | `string, URL, Uint8Array, Buffer, ArrayBuffer, or Array of Each` | PDF file(s) input source. Bytes are copied first, so the same buffer can be rendered again. |
| `options` | `Partial<Options>`                                               | (Optional) Conversion settings.                                                             |

✅ **Returns**:

- If `pages` is a single page (`firstPage`, `lastPage`, or a number) ➔ Single image.
- Otherwise ➔ Array of images.
- Each image is a base64 data URL, or with `returnType: "bytes"` a `PageImage`:
  `{ pageNumber, width, height, mime, bytes }` with the encoded PNG or JPEG as a
  `Uint8Array`. Use it when the image goes to a file or a store; it skips the
  base64 round trip and tells you the pixel size without decoding.

### Options (`Options` Interface)

```ts
interface Options {
  imgType?: "png" | "jpg"; // Default: "png"
  returnType?: "base64" | "bytes"; // Default: "base64" (a data URL)
  scale?: number; // Default: 1
  background?: string | CanvasGradient | CanvasPattern; // Default: "rgb(255,255,255)"
  intent?: "display" | "print" | "any"; // Default: "display"
  pages?: PagesType; // "all" | "firstPage" | "lastPage" | number | number[] | { startPage, endPage }
  documentOptions?: DocumentInitParameters; // (Optional) More PDF.js config.
  maxWidth?: number | null; // Default: null
  maxHeight?: number | null; // Default: null
  scaleForBrowserSupport?: boolean; // Default: false
  workerSrc?: string | URL | null; // Browser only. Default: null (see below)
}
```

### 🖽 Browser Support

- Auto-detects browser environment.
- Uses **Canvas API** for rendering pages.
- Returns a **base64 data URL** for each page, or a `PageImage` with
  `returnType: "bytes"` (encoded through `canvas.toBlob`).

#### The pdf.js worker

In the browser pdf.js reads the PDF in a Web Worker, loaded from its own URL,
and the worker has to be the exact pdf.js version this package runs. The package
ships that worker as `pdftoimg-js/worker`. Serve it from your own app and pass
its URL as `workerSrc`. With Vite, a `?url` import copies it into the build and
gives you the URL, so it always matches:

```ts
import { pdfToImg } from "pdftoimg-js/browser";
import workerSrc from "pdftoimg-js/worker?url";

const images = await pdfToImg(file, { workerSrc });
```

Other bundlers can do the same with their own asset-URL import, or you can copy
`node_modules/pdftoimg-js/dist/pdf.worker.min.mjs` into your public folder. A
hand-made copy has to be replaced whenever this package updates pdf.js, or pdf.js
refuses it ("The API version does not match the Worker version").

Without `workerSrc`, a `GlobalWorkerOptions.workerSrc` already set on this
package's pdf.js (`pdfjs-dist/legacy/build/pdf.mjs`) is kept, and otherwise the
worker is loaded from cdnjs for the matching version. That works without setup,
but every first render then waits on cdnjs, and fails if cdnjs is down or blocked
by a firewall, an ad blocker or a Content Security Policy.

### Transparent background

`background` takes any canvas fill style. `"rgba(0,0,0,0)"` (or `"transparent"`)
leaves everything the PDF does not paint transparent. Only PNG can keep that; a
JPG is always opaque.

```ts
const png = await pdfToImg(bytes, { pages: 1, background: "rgba(0,0,0,0)" });
```

### Bundlers, and Convex "use node" actions

pdf.js assumes it runs straight out of `node_modules`. Node has no Web Worker,
so pdf.js imports `./pdf.worker.mjs` relative to its own file the first time a
document loads, and it reads its standard fonts, CMaps, WASM decoders and ICC
profiles from disk. Both break once a bundler folds `pdfjs-dist` into a single
file: the worker import fails with "Setting up fake worker failed", and the
font paths point nowhere.

This package handles both. It imports the worker module itself, so a bundler
carries it along and pdf.js finds it on `globalThis.pdfjsWorker` without
touching the file system. And it resolves the asset directories from wherever
`pdfjs-dist` is installed (first relative to its own file, which inside a
bundle is the bundle, then relative to the working directory) instead of
hard-coding `node_modules/pdfjs-dist` under `process.cwd()`. When `pdfjs-dist`
is not on disk at all, PDFs with embedded fonts still render; pdf.js warns once
for each non-embedded standard font it cannot load. `pdfjsDistDir()` is exported
so you can check what was found.

[Convex](https://docs.convex.dev/functions/runtimes#nodejs-runtime) bundles
`"use node"` actions with esbuild and installs on the server only the packages
listed in `convex.json` under `node.externalPackages`. A native module can never
be bundled, and pdf.js is better kept out of the bundle so its fonts are on
disk, so list both:

```json
{
  "node": {
    "externalPackages": ["pdfjs-dist", "@napi-rs/canvas"],
    "nodeVersion": "22"
  }
}
```

Convex only treats a package as external when it finds it in your app's own
`package.json` and `node_modules`, so add both to the app too:

```bash
pnpm add pdfjs-dist@5.4.449 @napi-rs/canvas
```

```ts
// convex/rasterise.ts
"use node";
import { v } from "convex/values";
import { action } from "./_generated/server";
// Convex externalises a package only where the app imports it directly. With
// pnpm's default isolated node_modules the imports inside pdftoimg-js resolve
// to a different path and get bundled instead, so these two lines are what make
// Convex install the canvas and pdf.js on the server. With npm, or pnpm's
// node-linker=hoisted, they are not needed and do no harm.
import "@napi-rs/canvas";
import "pdfjs-dist/legacy/build/pdf.mjs";
import { pdfToImg } from "pdftoimg-js";

export const rasterise = action({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const blob = await ctx.storage.get(storageId);
    if (!blob) throw new Error("PDF not found");
    const image = await pdfToImg(await blob.arrayBuffer(), {
      pages: "firstPage",
      scale: 2,
      background: "rgba(0,0,0,0)",
      returnType: "bytes",
    });
    return await ctx.storage.store(
      new Blob([image.bytes], { type: image.mime }),
    );
  },
});
```

With pnpm the bundle still carries its own copy of pdf.js; the external one
supplies the fonts and the canvas. If `@napi-rs/canvas` is missing where the
bundle runs, the error says so and names `externalPackages`.

Any other bundler that targets Node needs the same two things: keep
`@napi-rs/canvas` external (it is a `.node` binary) and either keep `pdfjs-dist`
external or accept that non-embedded fonts fall back. `tests/convex-bundle.test.ts`
builds the package with esbuild using Convex's own options and runs the result
from an unrelated working directory, with only the packages placed beside the
bundle to resolve from, in both configurations.

## 👡 CLI Usage (Node.js Only)

Command-line support to batch convert PDFs easily!

```bash
pdftoimg -i <input> [-o <output>] [-t <imgType>] [-s <scale>] [-p <pages>] [-n <template>] [-ps <password>] [-b <background>] [-in <intent>] [-mw <maxWidth>] [-mh <maxHeight>] [-sb <scaleForBrowserSupport>]
```

### CLI Options

| Option                          | Type      | Description                                                                |
| :------------------------------ | :-------- | :------------------------------------------------------------------------- |
| `-i, --input`                   | `string`  | (Required) Input PDF path.                                                 |
| `-o, --out`                     | `string`  | Output directory (default: current directory).                             |
| `-t, --imgType`                 | `string`  | `png` or `jpg` (default: png).                                             |
| `-s, --scale`                   | `number`  | Scale factor (default: 1).                                                 |
| `-b, --background`              | `string`  | Background color (e.g., 'white', 'rgba(255,255,255,0.5)', '#ffffff').      |
| `-in, --intent`                 | `string`  | Rendering intent: 'display', 'print', or 'any' (default: 'display').       |
| `-p, --pages`                   | `string`  | `"all"`, `"firstPage"`, `"lastPage"`, page numbers, or ranges like `1..3`. |
| `-n, --name`                    | `string`  | Filename template `{i}`, `{p}`, `{ext}`, `{f}` available.                  |
| `-ps, --password`               | `string`  | Password for the PDF file if encrypted.                                    |
| `-mw, --maxWidth`               | `number`  | Maximum width for the rendered canvas.                                     |
| `-mh, --maxHeight`              | `number`  | Maximum height for the rendered canvas.                                    |
| `-sb, --scaleForBrowserSupport` | `boolean` | Scale for browser support.                                                 |

### ⚡ Example CLI Commands

Convert **first page** to PNG:

```bash
pdftoimg -i ./example.pdf -p firstPage
```

Convert **pages 1 to 3** to JPG:

```bash
pdftoimg -i ./example.pdf -t jpg -p 1..3
```

Save in a custom folder:

```bash
pdftoimg -i ./example.pdf -o ./output
```

Convert with custom background and print intent:

```bash
pdftoimg -i ./example.pdf -b "white" -in print
```

Convert with transparent background:

```bash
pdftoimg -i ./example.pdf -b "rgba(255,255,255,0)"
```

Convert with custom max width and height:

```bash
pdftoimg -i ./example.pdf -mw 1000 -mh 1000
```

Convert with scale for browser support:

```bash
pdftoimg -i ./example.pdf -sb true
```

## Contribution

Contributions are welcome! Feel free to check out the [Contributing Guide](https://github.com/tysonjf/pdftoimg-js/blob/main/.github/contributing.md) before making a pull request.
