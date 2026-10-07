import { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { Options, PageImage, PdfSrc, ReturnType } from "./types";
import {
  defaultOptions,
  getPagesArray,
  mimeFor,
  returnsSinglePage,
  toDocumentSource,
  workerSrcFor,
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

  const requiredOpt: Required<Options> = { ...defaultOptions, ...opt };

  // The worker must match the pdf.js version exactly, which the copy this
  // package ships as "pdftoimg-js/worker" always does.
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrcFor(
    requiredOpt.workerSrc,
    pdfjsLib.GlobalWorkerOptions.workerSrc,
    pdfjsLib.version,
  );

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
