import type {
  PDFDocumentProxy,
  PDFWorker,
} from "pdfjs-dist/types/src/display/api";
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

type PdfjsLib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let pdfjs: Promise<PdfjsLib> | undefined;

function loadPdfjs(): Promise<PdfjsLib> {
  return (pdfjs ??= import("pdfjs-dist/legacy/build/pdf.mjs"));
}

/**
 * The pdf.js Web Worker every call shares, by the URL it was loaded from.
 *
 * Starting a worker (a new thread, and the worker script loaded into it)
 * takes longer than rendering a page does, and a document never needs a
 * worker of its own: pdf.js keeps any number of documents on one worker.
 * So the first call starts it, every later call uses it, and it stays for
 * the life of the page. A second workerSrc gets a worker of its own.
 */
const workers = new Map<string, PDFWorker>();

function sharedWorker(pdfjsLib: PdfjsLib, workerSrc: string): PDFWorker {
  let worker = workers.get(workerSrc);
  if (!worker || worker.destroyed) {
    // Read by PDFWorker when it starts, and by nothing afterwards.
    pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
    worker = new pdfjsLib.PDFWorker();
    workers.set(workerSrc, worker);
  }
  return worker;
}

/**
 * Loads pdf.js and starts its worker ahead of the first render, so that
 * render does not wait for them. Call it when the page loads, or when it
 * becomes likely that a PDF is about to be rendered; `workerSrc` is the
 * same URL the render will be given.
 */
export async function preloadWorker(
  workerSrc: string | URL | null = null,
): Promise<void> {
  const pdfjsLib = await loadPdfjs();
  const src = workerSrcFor(
    workerSrc,
    pdfjsLib.GlobalWorkerOptions.workerSrc,
    pdfjsLib.version,
  );
  await sharedWorker(pdfjsLib, src).promise;
}

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

  // The worker must match the pdf.js version exactly, which the copy this
  // package ships as "pdftoimg-js/worker" always does.
  const workerSrc = workerSrcFor(
    requiredOpt.workerSrc,
    pdfjsLib.GlobalWorkerOptions.workerSrc,
    pdfjsLib.version,
  );

  const pdfDocLoading = pdfjsLib.getDocument({
    worker: sharedWorker(pdfjsLib, workerSrc),
    ...toDocumentSource(src),
    ...requiredOpt.documentOptions,
  });

  try {
    const pdfDoc = await pdfDocLoading.promise;

    const numPages = pdfDoc.numPages;

    const pageNums: number[] = getPagesArray(requiredOpt.pages, numPages);

    const images = await Promise.all(
      pageNums.map((n) => pageToImg(pdfDoc, n, requiredOpt)),
    );

    return returnsSinglePage(requiredOpt.pages) ? images[0] : images;
  } finally {
    // Frees the document on the worker; the worker itself stays for the
    // next call, as a worker passed to getDocument is the caller's to keep.
    await pdfDocLoading.destroy();
  }
}

/** Whether a canvas fill style covers the canvas completely, by trying it. */
const opacity = new Map<string, boolean>();

function isOpaque(fillStyle: string): boolean {
  let opaque = opacity.get(fillStyle);
  if (opaque === undefined) {
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const context = probe.getContext("2d");
    if (context) {
      context.fillStyle = fillStyle;
      context.fillRect(0, 0, 1, 1);
      opaque = context.getImageData(0, 0, 1, 1).data[3] === 255;
    } else {
      opaque = false;
    }
    opacity.set(fillStyle, opaque);
  }
  return opaque;
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

  // Any canvas fillStyle. "rgba(0,0,0,0)" keeps the page transparent.
  const background = opt.background || "rgb(255,255,255)";

  const canvas = document.createElement("canvas");

  // A canvas that the background will cover completely can do without an
  // alpha channel: the browser then skips the alpha work when drawing and
  // writes a PNG without one, about a sixth smaller. Anything that might
  // leave the page see-through keeps the channel.
  const opaque = typeof background === "string" && isOpaque(background);
  const canvasContext = canvas.getContext("2d", {
    alpha: !opaque,
  }) as CanvasRenderingContext2D;

  canvas.height = viewport.height;
  canvas.width = viewport.width;

  // `canvas: null` makes pdf.js (5 and later) draw into this context as given
  // instead of opening its own opaque one, so a transparent `background`
  // survives.
  const renderTask = page.render({
    canvas: null,
    canvasContext,
    viewport,
    intent: opt.intent || "display",
    background,
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
