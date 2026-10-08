import type {
  PDFDocumentProxy,
  PDFPageProxy,
} from "pdfjs-dist/types/src/display/api";
import { describeCanvasFailure } from "./pdfjs-node";
import { encodePng, encodePngSync } from "./png";
import type { Options, PageImage } from "./types";
import { mimeFor } from "./utils";

/** The slice of pdf.js's Node canvas factory (@napi-rs/canvas underneath) this file uses. */
export interface NodeCanvasFactory {
  create(width: number, height: number): CanvasAndContext;
  destroy(canvasAndContext: CanvasAndContext): void;
}

export interface CanvasAndContext {
  canvas: NodeCanvas;
  context: unknown;
}

export interface NodeCanvas {
  width: number;
  height: number;
  toDataURL(mime: string): string;
  /** @napi-rs/canvas: encode off the main thread. */
  encode?(format: "png" | "jpeg"): Promise<Uint8Array>;
  /** @napi-rs/canvas: encode on the calling thread. */
  encodeSync?(format: "png" | "jpeg"): Uint8Array;
}

/** The one method of a 2D context the PNG writer needs. */
interface PixelSource {
  getImageData(
    sx: number,
    sy: number,
    sw: number,
    sh: number,
  ): { data: Uint8ClampedArray };
}

export interface RenderedPage {
  page: PDFPageProxy;
  canvasAndContext: CanvasAndContext;
}

/** Draws one page of the document onto a fresh canvas from the document's factory. */
export async function renderPage(
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

  // `canvas: null` tells pdf.js (5 and later) to draw into the context as
  // given. With a canvas (passed, or taken from the context by default) it
  // opens its own context with `alpha: false`, and a transparent `background`
  // turns opaque.
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

export interface EncodeOptions {
  /**
   * Compress on the calling thread instead of a libuv thread. For a worker
   * thread with nothing else to do, which would otherwise sit idle while the
   * shared thread pool compresses for it.
   */
  sync?: boolean;
}

/**
 * Encodes a rendered page and releases its page and canvas, whether or not
 * the encode succeeds.
 */
export async function encodePage(
  pdfDoc: PDFDocumentProxy,
  { page, canvasAndContext }: RenderedPage,
  pageNumber: number,
  opt: Required<Options>,
  { sync = false }: EncodeOptions = {},
): Promise<PageImage> {
  const { canvas } = canvasAndContext;
  const mime = mimeFor(opt.imgType);
  // Read the size off the canvas: a fractional viewport is rounded there.
  const { width, height } = canvas;
  try {
    const bytes = await encodeCanvas(canvasAndContext, mime, sync);
    return { pageNumber, width, height, mime, bytes };
  } finally {
    page.cleanup();
    (pdfDoc.canvasFactory as NodeCanvasFactory).destroy(canvasAndContext);
  }
}

function encodeCanvas(
  { canvas, context }: CanvasAndContext,
  mime: PageImage["mime"],
  sync: boolean,
): Uint8Array | Promise<Uint8Array> {
  const { width, height } = canvas;
  if (mime === "image/png" && hasGetImageData(context)) {
    // @napi-rs/canvas records the drawing calls and rasterises them on the
    // first read of the pixels, so this call is where pdf.js's drawing is
    // paid for, on whichever thread owns the canvas. The compression that
    // follows is the part a libuv thread can take.
    const { data } = context.getImageData(0, 0, width, height);
    return sync
      ? encodePngSync(data, width, height)
      : encodePng(data, width, height);
  }
  const format = mime === "image/jpeg" ? "jpeg" : "png";
  if (sync && typeof canvas.encodeSync === "function") {
    // A plain Uint8Array, not a Buffer that may sit in Node's shared pool.
    return new Uint8Array(canvas.encodeSync(format));
  }
  if (typeof canvas.encode === "function") {
    return canvas.encode(format).then((encoded) => new Uint8Array(encoded));
  }
  // Some other canvas (a custom `CanvasFactory` in `documentOptions`): take
  // the data URL it can make and unwrap it.
  const dataUrl = canvas.toDataURL(mime);
  return new Uint8Array(
    Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"),
  );
}

function hasGetImageData(context: unknown): context is PixelSource {
  return (
    typeof context === "object" &&
    context !== null &&
    typeof (context as PixelSource).getImageData === "function"
  );
}
