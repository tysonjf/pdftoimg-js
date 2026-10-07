import {
  DocumentInitParameters,
  TypedArray,
} from "pdfjs-dist/types/src/display/api";

export type DocumentParams = Omit<DocumentInitParameters, "data" | "url">;

export type PagesType =
  | { startPage?: number; endPage?: number }
  | "firstPage"
  | "lastPage"
  | "all"
  | number
  | number[];

/**
 * One rendered page, when `returnType` is "bytes".
 */
export interface PageImage {
  /** 1-based page number in the source document. */
  pageNumber: number;
  /** Pixel size of the image. */
  width: number;
  height: number;
  mime: "image/png" | "image/jpeg";
  /** The encoded image. */
  bytes: Uint8Array;
}

export interface Options {
  /**
   * The type of image to output. Can be 'png' or 'jpg'. The default value is 'png'.
   */
  imgType?: "png" | "jpg";
  /**
   * What each page comes back as. "base64" is a data URL string; "bytes" is a
   * `PageImage` with the encoded bytes, the pixel size and the page number, and
   * saves the base64 round trip when the image is going to a file or a store.
   * The default value is "base64".
   */
  returnType?: "base64" | "bytes";
  /**
   * The scale of the rendered image. The default value is 1.
   */
  scale?: number;
  /**
   * Background to use for the canvas. Any valid canvas.fillStyle can be used:
   * a DOMString parsed as CSS value, a CanvasGradient object (a linear or radial gradient)
   * or a CanvasPattern object (a repetitive image).
   * The default value is 'rgb(255,255,255)'.
   */
  background?: string | CanvasGradient | CanvasPattern | undefined;
  /**
   * Rendering intent, can be 'display', 'print', or 'any'. The default value is 'display'.
   */
  intent?: "display" | "print" | "any";
  /**
   * Specifies which pages to render from the PDF document. Can be:
   * - A single page number (e.g. 1)
   * - A page range object with optional startPage and endPage (e.g. {startPage: 1, endPage: 3})
   * - "firstPage" to render only the first page
   * - "lastPage" to render only the last page
   * - "all" to render all pages
   * - An array of specific page numbers (e.g. [1, 3, 5])
   * @default "all"
   */
  pages?: PagesType;
  /**
   * Additional document options.
   */
  documentOptions?: DocumentParams;

  /**
   * Maximum width (in pixels) for the rendered canvas.
   * If the rendered canvas would exceed this, it will be downscaled proportionally.
   * @default null
   */
  maxWidth?: number | null;

  /**
   * Maximum height (in pixels) for the rendered canvas.
   * If the rendered canvas would exceed this, it will be downscaled proportionally.
   * @default null
   */
  maxHeight?: number | null;

  /**
   * Automatically downscale large PDF pages to avoid browser canvas size limitations.
   * Ensures consistent rendering across browsers like Safari with stricter limits.
   * Uses default max dimensions of 4096x4096 pixels unless overridden by maxWidth/maxHeight.
   * @default false
   */
  scaleForBrowserSupport?: boolean;

  /**
   * Browser only: the URL pdf.js loads its worker from. It has to be the
   * worker of the exact pdf.js version this package runs, which this package
   * ships as `pdftoimg-js/worker`; with Vite, pass
   * `import workerSrc from "pdftoimg-js/worker?url"`. Without it, a
   * `GlobalWorkerOptions.workerSrc` already set on this package's pdf.js is
   * kept, and otherwise the worker comes from cdnjs. Ignored in Node, where
   * the worker runs in-process.
   * @default null
   */
  workerSrc?: string | URL | null;
}

type PageResult<O extends Options> = O["returnType"] extends "bytes"
  ? PageImage
  : string;

type PerSrcReturn<O extends Options> = O["pages"] extends
  number | "firstPage" | "lastPage"
  ? PageResult<O>
  : PageResult<O>[];

export type PdfSrc = string | URL | TypedArray | ArrayBuffer;

export type ReturnType<
  O extends Options,
  S extends PdfSrc | PdfSrc[],
> = S extends PdfSrc[] ? PerSrcReturn<O>[] : PerSrcReturn<O>;
