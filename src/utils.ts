import { Options, PageImage, PagesType, PdfSrc } from "./types";

export const defaultOptions: Required<Options> = {
  imgType: "png",
  returnType: "base64",
  pages: "all",
  scale: 1.0,
  background: "rgb(255,255,255)",
  intent: "display",
  documentOptions: {},
  maxWidth: null,
  maxHeight: null,
  scaleForBrowserSupport: false,
};

export const rangeToArr = (start: number, end?: number): number[] => {
  const from = end !== undefined ? start : 1;
  const to = end !== undefined ? end : start;
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
};

/** A single page selection returns one image rather than a list. */
export function returnsSinglePage(pages: PagesType): boolean {
  return (
    pages === "firstPage" || pages === "lastPage" || typeof pages === "number"
  );
}

export function mimeFor(imgType: Options["imgType"]): PageImage["mime"] {
  return imgType === "jpg" ? "image/jpeg" : "image/png";
}

export function getPagesArray(pages: PagesType, numPages: number) {
  return pages === "firstPage"
    ? [1]
    : pages === "lastPage"
      ? [numPages]
      : typeof pages === "number"
        ? [Math.max(1, pages)]
        : Array.isArray(pages)
          ? pages.length
            ? pages
            : [1]
          : typeof pages === "object"
            ? rangeToArr(pages.startPage ?? 1, pages.endPage ?? numPages)
            : rangeToArr(1, numPages);
}

export function isTypedArrayStrict(
  value: unknown,
): value is
  | Int8Array
  | Uint8Array
  | Uint8ClampedArray
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array {
  return (
    value instanceof Int8Array ||
    value instanceof Uint8Array ||
    value instanceof Uint8ClampedArray ||
    value instanceof Int16Array ||
    value instanceof Uint16Array ||
    value instanceof Int32Array ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Float64Array
  );
}

/**
 * pdf.js wants `data` as a plain Uint8Array (it refuses a Node Buffer) and
 * takes ownership of it: the bytes are transferred to its worker, which
 * detaches the caller's buffer even with the fake worker Node uses. Copying
 * keeps the caller's input usable, for a second render or anything else.
 */
export function toDocumentSource(
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
