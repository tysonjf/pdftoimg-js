import { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { Options, PageImage, PdfSrc, ReturnType } from "./types";
import {
  defaultOptions,
  getPagesArray,
  isTypedArrayStrict,
  mimeFor,
  returnsSinglePage,
} from "./utils";

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
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // The worker must match the pdf.js version exactly. Leave it alone when the
  // host app already pointed pdf.js at its own copy.
  pdfjsLib.GlobalWorkerOptions.workerSrc ||= `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const requiredOpt: Required<Options> = { ...defaultOptions, ...opt };

  const pdfDocLoading = pdfjsLib.getDocument({
    ...toDocumentSource(src),
    ...requiredOpt.documentOptions,
  });

  const pdfDoc = await pdfDocLoading.promise;

  const numPages = pdfDoc.numPages;

  const pageNums: number[] = getPagesArray(requiredOpt.pages, numPages);

  const images = await Promise.all(
    pageNums.map((n) => pageToImg(pdfDoc, n, requiredOpt)),
  );

  return returnsSinglePage(requiredOpt.pages) ? images[0] : images;
}

// pdf.js transfers `data` to its worker and detaches the caller's buffer, so
// the bytes are copied first and the input stays usable.
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

async function pageToImg(
  pdfDoc: PDFDocumentProxy,
  pageNum: number,
  opt: Required<Options>,
): Promise<string | PageImage> {
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

  const canvas = document.createElement("canvas");

  const canvasContext = canvas.getContext("2d") as CanvasRenderingContext2D;

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  // `canvas: null` makes pdf.js 5 draw into this context as given instead of
  // opening its own opaque one, so a transparent `background` survives.
  const renderTask = page.render({
    canvas: null,
    canvasContext,
    viewport,
    intent: opt.intent || "display",
    background: opt.background || "rgb(255,255,255)",
  });

  await renderTask.promise;

  const mime = mimeFor(opt.imgType);
  if (opt.returnType === "bytes") {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, mime),
    );
    if (!blob) {
      throw new Error(`canvas.toBlob produced nothing for page ${pageNum}`);
    }
    return {
      pageNumber: pageNum,
      width: canvas.width,
      height: canvas.height,
      mime,
      bytes: new Uint8Array(await blob.arrayBuffer()),
    };
  }
  return canvas.toDataURL(mime);
}
