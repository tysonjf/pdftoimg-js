// The worker thread side of src/pool.ts: one pdf.js and one canvas of its
// own, documents opened on request, and pages rendered one at a time.
import { parentPort } from "node:worker_threads";
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
} from "pdfjs-dist/types/src/display/api";
import { loadPdfjs } from "./pdfjs-node";
import type { FromWorker, SerializedError, ToWorker } from "./pool";
import { encodePage, renderPage } from "./render";

if (!parentPort) {
  throw new Error("pdftoimg-js's render worker must run as a worker thread");
}
const port = parentPort;
const pdfjs = await loadPdfjs();
const docs = new Map<number, PDFDocumentLoadingTask>();

port.on("message", (message: ToWorker) => {
  void handle(message);
});
post({ type: "ready" });

async function handle(message: ToWorker): Promise<void> {
  switch (message.type) {
    case "open": {
      const { docId, params } = message;
      const task = pdfjs.getDocument(params as DocumentInitParameters);
      docs.set(docId, task);
      try {
        await task.promise;
        post({ type: "opened", docId });
      } catch (error) {
        docs.delete(docId);
        await task.destroy().catch(() => {});
        post({ type: "openFailed", docId, error: serialize(error) });
      }
      return;
    }
    case "render": {
      const { docId, jobId, pageNumber, options } = message;
      try {
        const task = docs.get(docId);
        if (!task) {
          throw new Error(`Document ${docId} is not open in this worker.`);
        }
        const pdfDoc = await task.promise;
        const rendered = await renderPage(pdfDoc, pageNumber, options);
        // This thread has nothing else to do, so it compresses itself rather
        // than queueing on the thread pool it shares with the whole process.
        const image = await encodePage(pdfDoc, rendered, pageNumber, options, {
          sync: true,
        });
        port.postMessage(
          { type: "rendered", jobId, image } satisfies FromWorker,
          [image.bytes.buffer as ArrayBuffer],
        );
      } catch (error) {
        post({ type: "failed", jobId, error: serialize(error) });
      }
      return;
    }
    case "close": {
      const { docId } = message;
      const task = docs.get(docId);
      docs.delete(docId);
      await task?.destroy().catch(() => {});
      post({ type: "closed", docId });
    }
  }
}

function post(message: FromWorker): void {
  port.postMessage(message);
}

function serialize(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { name: "Error", message: String(error) };
}
