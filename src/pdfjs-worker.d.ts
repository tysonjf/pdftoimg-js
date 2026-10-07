// pdfjs-dist ships no declaration file for its worker entry. We import the
// module for its side effect only (it registers itself on
// `globalThis.pdfjsWorker`), so a minimal declaration is enough.
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
