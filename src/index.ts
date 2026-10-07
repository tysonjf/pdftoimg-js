import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import {
  describeCanvasFailure,
  loadPdfjs,
  pdfjsAssetParams,
} from "./pdfjs-node";
import { Options, PageImage, PdfSrc, ReturnType } from "./types";
import {
  defaultOptions,
  getPagesArray,
  mimeFor,
  returnsSinglePage,
  toDocumentSource,
} from "./utils";

export { pdfjsDistDir } from "./pdfjs-node";
export type { PageImage } from "./types";

export function pdfToImg<O extends Options, S extends PdfSrc | PdfSrc[]>(
  src: S,
  options?: O,
): Promise<ReturnType<O, S>> {
  const convert = async (file: PdfSrc) => await singlePdfToImg(file, options);

  if (Array.isArray(src)) {
    return Promise.all(src.map(convert)) as Promise<ReturnType<O, S>>;
  }
  return convert(src) as Promise<ReturnType<O, S>>;
}

export async function singlePdfToImg(src: PdfSrc, opt: Partial<Options> = {}) {
  const pdfjsLib = await loadPdfjs();

  const requiredOpt: Required<Options> = { ...defaultOptions, ...opt };

  const pdfDocLoading = pdfjsLib.getDocument({
    ...pdfjsAssetParams(),
    ...toDocumentSource(src),
    ...requiredOpt.documentOptions,
  });

  const pdfDoc = await pdfDocLoading.promise;

  const encoding: Promise<PageImage>[] = [];
  try {
    const pageNums: number[] = getPagesArray(
      requiredOpt.pages,
      pdfDoc.numPages,
    );

    // Pages are rasterised one after another, on purpose. pdf.js in Node runs
    // its "worker" on the main thread, so rendering pages concurrently only
    // interleaves them and raises peak memory (14 A4 pages: 3.8 s concurrent,
    // 3.1 s sequential). Encoding is the part that does run in parallel:
    // @napi-rs/canvas encodes on a libuv thread, so each page's encode is
    // started as soon as it is drawn and collected at the end.
    for (const pageNum of pageNums) {
      const rendered = await renderPage(pdfDoc, pageNum, requiredOpt);
      const encoded = encodePage(pdfDoc, rendered, pageNum, requiredOpt);
      // The next page renders before anything awaits this one. Without a
      // handler attached now, a failed encode counts as an unhandled
      // rejection and Node's default mode exits the process over it.
      encoded.catch(() => {});
      encoding.push(encoded);
    }
    const images = await Promise.all(encoding);

    const results =
      requiredOpt.returnType === "bytes" ? images : images.map(toDataUrl);
    return returnsSinglePage(requiredOpt.pages) ? results[0] : results;
  } finally {
    // Let encodes still running (a later page failed to render, or another
    // encode failed) finish before the document goes away under them.
    await Promise.allSettled(encoding);
    // A long-lived process (a serverless function instance, for one) would
    // otherwise keep every document it ever rendered.
    await pdfDoc.destroy();
  }
}

/** The slice of pdf.js's Node canvas factory (@napi-rs/canvas underneath) this file uses. */
interface NodeCanvasFactory {
  create(width: number, height: number): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

interface CanvasAndContext {
  canvas: NodeCanvas;
  context: unknown;
}

interface NodeCanvas {
  width: number;
  height: number;
  toDataURL(mime: string): string;
  /** @napi-rs/canvas: encode off the main thread. */
  encode?(format: "png" | "jpeg"): Promise<Uint8Array>;
}

interface RenderedPage {
  page: PDFPageProxy;
  canvasAndContext: CanvasAndContext;
}

async function renderPage(
  pdfDoc: PDFDocumentProxy,
  pageNum: number,
  opt: Required<Options>,
): Promise<RenderedPage> {
  const page = await pdfDoc.getPage(pageNum);
  let scale = opt.scale;
  let viewport = page.getViewport({ scale });

  if (opt.scaleForBrowserSupport || opt.maxWidth || opt.maxHeight) {
    let { maxWidth, maxHeight } = opt;
    maxWidth = maxWidth ?? 4096;
    maxHeight = maxHeight ?? 4096;
    const widthScale = maxWidth / viewport.width;
    const heightScale = maxHeight / viewport.height;
    const safeScale = Math.min(widthScale, heightScale, 1);
    scale = scale * safeScale;
    viewport = page.getViewport({ scale });
  }

  // pdf.js's factory refuses an empty canvas with "Invalid canvas size", and
  // @napi-rs/canvas truncates a fractional size, so check before asking.
  if (!(viewport.width >= 1 && viewport.height >= 1)) {
    throw new Error(
      `Page ${pageNum} would render at ${viewport.width}x${viewport.height} px ` +
        `(scale ${scale}). The scale must give the page at least 1x1 px.`,
    );
  }

  // pdf.js's own Node canvas factory, backed by @napi-rs/canvas.
  const canvasFactory = pdfDoc.canvasFactory as NodeCanvasFactory;
  let canvasAndContext: CanvasAndContext;
  try {
    canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  } catch (error) {
    throw describeCanvasFailure(error);
  }

  // `canvas: null` tells pdf.js 5 to draw into the context as given. With a
  // canvas (passed, or taken from the context by default) it opens its own
  // context with `alpha: false`, and a transparent `background` turns opaque.
  const renderTask = page.render({
    canvas: null,
    canvasContext: canvasAndContext.context as CanvasRenderingContext2D,
    viewport,
    // Any canvas fillStyle. "rgba(0,0,0,0)" keeps the page transparent.
    background: opt.background || "rgb(255,255,255)",
    intent: opt.intent || "display",
  });

  await renderTask.promise;
  return { page, canvasAndContext };
}

async function encodePage(
  pdfDoc: PDFDocumentProxy,
  { page, canvasAndContext }: RenderedPage,
  pageNumber: number,
  opt: Required<Options>,
): Promise<PageImage> {
  const { canvas } = canvasAndContext;
  const mime = mimeFor(opt.imgType);
  // Read the size off the canvas: a fractional viewport is rounded there.
  const { width, height } = canvas;
  try {
    const bytes = await encodeCanvas(canvas, mime);
    return { pageNumber, width, height, mime, bytes };
  } finally {
    page.cleanup();
    (pdfDoc.canvasFactory as NodeCanvasFactory).destroy(canvasAndContext);
  }
}

async function encodeCanvas(
  canvas: NodeCanvas,
  mime: PageImage["mime"],
): Promise<Uint8Array> {
  if (typeof canvas.encode === "function") {
    const encoded = await canvas.encode(mime === "image/jpeg" ? "jpeg" : "png");
    // A plain Uint8Array, not a Buffer that may sit in Node's shared pool.
    return new Uint8Array(encoded);
  }
  // Some other canvas (a custom `CanvasFactory` in `documentOptions`): take
  // the data URL it can make and unwrap it.
  const dataUrl = canvas.toDataURL(mime);
  return new Uint8Array(
    Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
  );
}

function toDataUrl(image: PageImage): string {
  const base64 = Buffer.from(
    image.bytes.buffer,
    image.bytes.byteOffset,
    image.bytes.byteLength,
  ).toString("base64");
  return `data:${image.mime};base64,${base64}`;
}
