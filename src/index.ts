import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { loadPdfjs, pdfjsAssetParams } from "./pdfjs-node";
import {
  defaultThreads,
  isPlainData,
  poolAvailable,
  startOnPool,
  type PoolHandle,
} from "./pool";
import { encodePage, renderPage } from "./render";
import { Options, PageImage, PdfSrc, ReturnType } from "./types";
import {
  defaultOptions,
  getPagesArray,
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

  try {
    const pdfDoc = await pdfDocLoading.promise;
    const pageNums: number[] = getPagesArray(
      requiredOpt.pages,
      pdfDoc.numPages,
    );
    const images = await renderPages(pdfDoc, pageNums, requiredOpt, src);
    const results =
      requiredOpt.returnType === "bytes" ? images : images.map(toDataUrl);
    return returnsSinglePage(requiredOpt.pages) ? results[0] : results;
  } finally {
    // A long-lived process (a serverless function instance, for one) would
    // otherwise keep every document it ever rendered. The loading task owns
    // the document and its worker, and is also what a failed load leaves.
    await pdfDocLoading.destroy();
  }
}

/**
 * Renders the pages, in the order asked for.
 *
 * pdf.js in Node parses and draws on the thread that opened the document, so
 * this thread takes pages from the queue one after another: rendering them
 * concurrently here would only interleave them and raise peak memory. The
 * drawing is paid for when a page's pixels are read, at the start of its
 * encode; the compression after that runs on a libuv thread, so the next
 * page is drawn while the previous one compresses. For more than one page
 * the worker threads of the render pool take pages from the same queue, each
 * with its own pdf.js, and the whole document finishes when the queue is
 * empty and everyone is done.
 */
async function renderPages(
  pdfDoc: PDFDocumentProxy,
  pageNums: number[],
  opt: Required<Options>,
  src: PdfSrc,
): Promise<PageImage[]> {
  const queue = [...new Set(pageNums)];
  const results = new Map<number, PageImage>();
  let failure: { error: unknown } | undefined;
  const fail = (error: unknown) => {
    failure ??= { error };
  };
  const take = () => (failure ? undefined : queue.shift());

  const pool = startPool(queue.length, opt, src, {
    take,
    putBack: (pageNumber) => queue.push(pageNumber),
    onResult: (pageNumber, image) => results.set(pageNumber, image),
    onFailure: fail,
  });

  const encoding: Promise<void>[] = [];
  const renderHere = async () => {
    for (
      let pageNumber = take();
      pageNumber !== undefined;
      pageNumber = take()
    ) {
      try {
        const rendered = await renderPage(pdfDoc, pageNumber, opt);
        encoding.push(
          encodePage(pdfDoc, rendered, pageNumber, opt).then((image) => {
            results.set(pageNumber, image);
          }, fail),
        );
      } catch (error) {
        fail(error);
      }
    }
    // Encodes still running (a later page failed to render, or another
    // encode failed) finish before the document goes away under them.
    await Promise.all(encoding);
  };

  try {
    do {
      await renderHere();
      await pool?.drain();
      // A worker that died or could not open the document hands its page
      // back, so the queue may have refilled.
    } while (!failure && queue.length > 0);
  } finally {
    await pool?.release();
  }

  if (failure) {
    throw failure.error;
  }
  return pageNums.map((pageNumber) => results.get(pageNumber)!);
}

function startPool(
  pages: number,
  opt: Required<Options>,
  src: PdfSrc,
  call: Pick<
    Parameters<typeof startOnPool>[0],
    "take" | "putBack" | "onResult" | "onFailure"
  >,
): PoolHandle | undefined {
  const threads = Math.min(opt.threads ?? defaultThreads(), pages - 1);
  // Everything a worker receives crosses a thread boundary by structured
  // clone, which a class (a custom CanvasFactory) or a native object (a
  // CanvasGradient) does not survive. Such a call stays on this thread.
  const options = { ...opt, workerSrc: null };
  if (!(threads >= 1) || !poolAvailable() || !isPlainData(options)) {
    return undefined;
  }
  return startOnPool(
    {
      ...call,
      options,
      openParams: () => {
        // A fresh copy for each worker: pdf.js takes ownership of the bytes.
        const source = toDocumentSource(src);
        const params = {
          ...pdfjsAssetParams(),
          ...("url" in source ? { url: String(source.url) } : source),
          ...opt.documentOptions,
        };
        return {
          params,
          transfer: "data" in source ? [source.data.buffer as ArrayBuffer] : [],
        };
      },
    },
    threads,
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
