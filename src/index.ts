import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import {
  describeCanvasFailure,
  loadPdfjs,
  pdfjsAssetParams,
} from "./pdfjs-node";
import { Options, PdfSrc, ReturnType } from "./types";
import { defaultOptions, getPagesArray, isTypedArrayStrict } from "./utils";

export { pdfjsDistDir } from "./pdfjs-node";

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

  try {
    const numPages = pdfDoc.numPages;

    const pageNums: number[] = getPagesArray(requiredOpt.pages, numPages);

    const images = await Promise.all(
      pageNums.map((n) => pageToImg(pdfDoc, n, requiredOpt)),
    );

    return requiredOpt.pages === "firstPage" ||
      requiredOpt.pages === "lastPage" ||
      typeof requiredOpt.pages === "number"
      ? images[0]
      : images;
  } finally {
    // A long-lived process (a serverless function instance, for one) would
    // otherwise keep every document it ever rendered.
    await pdfDoc.destroy();
  }
}

/**
 * pdf.js wants `data` as a plain Uint8Array (it refuses a Node Buffer) and
 * takes ownership of it: the bytes are transferred to its worker, which
 * detaches the caller's buffer even with the fake worker Node uses. Copying
 * keeps the caller's input usable, for a second render or anything else.
 */
function toDocumentSource(
  src: PdfSrc,
): { data: Uint8Array } | { url: string | URL } {
  if (src instanceof ArrayBuffer) {
    return { data: new Uint8Array(src.slice(0)) };
  }
  if (isTypedArrayStrict(src)) {
    return {
      data: new Uint8Array(
        src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength),
      ),
    };
  }
  return { url: src };
}

interface NodeCanvasFactory {
  create(
    width: number,
    height: number,
  ): { canvas: NodeCanvas; context: unknown };
}

interface NodeCanvas {
  toDataURL(mime: string): string;
}

async function pageToImg(
  pdfDoc: PDFDocumentProxy,
  pageNum: number,
  opt: Required<Options>,
): Promise<string> {
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

  // pdf.js's own Node canvas factory, backed by @napi-rs/canvas.
  const canvasFactory = pdfDoc.canvasFactory as NodeCanvasFactory;
  let created: { canvas: NodeCanvas; context: unknown };
  try {
    created = canvasFactory.create(viewport.width, viewport.height);
  } catch (error) {
    throw describeCanvasFailure(error);
  }
  const { canvas, context } = created;

  // `canvas: null` tells pdf.js 5 to draw into the context as given. With a
  // canvas (passed, or taken from the context by default) it opens its own
  // context with `alpha: false`, and a transparent `background` turns opaque.
  const renderTask = page.render({
    canvas: null,
    canvasContext: context as CanvasRenderingContext2D,
    viewport,
    // Any canvas fillStyle. "rgba(0,0,0,0)" keeps the page transparent.
    background: opt.background || "rgb(255,255,255)",
    intent: opt.intent || "display",
  });

  await renderTask.promise;
  page.cleanup();

  const mime = opt.imgType === "jpg" ? "image/jpeg" : "image/png";
  return canvas.toDataURL(mime);
}
