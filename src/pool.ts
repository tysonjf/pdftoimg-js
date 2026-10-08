import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Options, PageImage } from "./types";

/**
 * A pool of worker threads that render pages alongside the calling thread.
 *
 * pdf.js in Node parses, draws and rasterises on one thread, so a document's
 * pages are rendered one after another there. Each worker here runs its own
 * pdf.js and its own canvas, opens the document itself, and takes pages from
 * the same queue the calling thread works through, so a multi-page document
 * renders on as many threads as there are pages or CPUs. Workers are started
 * on first use, shared by every call in the process, and stopped again after
 * a while idle. The worker file is built next to this one; when it is not
 * there (the package was bundled into a single file) everything renders on
 * the calling thread, as it did before the pool existed.
 */

/** Options as sent to a worker. `workerSrc` is browser-only and never sent. */
export type RenderOptions = Required<Options>;

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ToWorker =
  | { type: "open"; docId: number; params: Record<string, unknown> }
  | {
      type: "render";
      docId: number;
      jobId: number;
      pageNumber: number;
      options: RenderOptions;
    }
  | { type: "close"; docId: number };

export type FromWorker =
  | { type: "ready" }
  | { type: "opened"; docId: number }
  | { type: "openFailed"; docId: number; error: SerializedError }
  | { type: "rendered"; jobId: number; image: PageImage }
  | { type: "failed"; jobId: number; error: SerializedError }
  | { type: "closed"; docId: number };

/** What one call to pdfToImg hands the pool. */
export interface PoolCall {
  /**
   * Parameters for pdf.js's getDocument in a worker. Built once per worker,
   * because the bytes in them are transferred, not copied.
   */
  openParams(): { params: Record<string, unknown>; transfer: ArrayBuffer[] };
  options: RenderOptions;
  /** The next page to render, or undefined when there is none left. */
  take(): number | undefined;
  /** Hands back a page a worker could not render, for someone else to take. */
  putBack(pageNumber: number): void;
  onResult(pageNumber: number, image: PageImage): void;
  onFailure(error: unknown): void;
}

export interface PoolHandle {
  /**
   * Resolves once no worker is rendering a page of this call. A worker may
   * start another the moment one is free and the queue is not empty, so the
   * caller loops over its own rendering and this until the queue is empty.
   */
  drain(): Promise<void>;
  /** Waits for the workers' pages, then closes the document on each of them. */
  release(): Promise<void>;
}

/** Never more than this many workers by default; `threads` can ask for more. */
const MAX_DEFAULT_THREADS = 4;
/** Idle workers are stopped after this long, and their memory given back. */
const IDLE_MS = 30_000;

interface Slot {
  worker: Worker;
  ready: boolean;
  busy: boolean;
  alive: boolean;
  /** Documents opened on this worker, by id, with the open's outcome. */
  docs: Map<number, Promise<void>>;
  /** Documents this worker could not open; the others render their pages. */
  failedDocs: Set<number>;
  pending: Map<
    string,
    { resolve: (reply: FromWorker) => void; reject: (error: Error) => void }
  >;
}

interface ActiveCall {
  call: PoolCall;
  docId: number;
  inFlight: number;
  /** Pages handed back after a worker died; each is retried once. */
  retried: Set<number>;
  /** Workers that opened this call's document. */
  slots: Set<Slot>;
  released: boolean;
  drainWaiters: (() => void)[];
}

let slots: Slot[] = [];
let active: ActiveCall[] = [];
let nextDocId = 1;
let nextJobId = 1;
let nextCall = 0;
let idleTimer: NodeJS.Timeout | undefined;
let disabled = false;
let workerUrl: URL | null | undefined;

/** Points the pool at another worker file. For tests, which run from src/. */
export function setRenderWorkerUrl(url: URL | null | undefined): void {
  workerUrl = url;
}

function resolveWorkerUrl(): URL | null {
  if (workerUrl === undefined) {
    const url = new URL("./render-worker.mjs", import.meta.url);
    workerUrl =
      url.protocol === "file:" && existsSync(fileURLToPath(url)) ? url : null;
  }
  return workerUrl;
}

/** Whether pages can be rendered on worker threads here. */
export function poolAvailable(): boolean {
  return !disabled && resolveWorkerUrl() !== null;
}

/** One worker per CPU beyond the one the calling thread runs on, up to a cap. */
export function defaultThreads(): number {
  return Math.max(0, Math.min(availableParallelism() - 1, MAX_DEFAULT_THREADS));
}

/**
 * Whether a value survives structured cloning with its meaning intact: no
 * functions, no class instances (they arrive as plain objects), no platform
 * objects. Options that fail this render on the calling thread.
 */
export function isPlainData(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return true;
    case "object":
      break;
    default:
      return false;
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isPlainData);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }
  return Object.values(value).every(isPlainData);
}

/** Starts rendering the call's pages on up to `threads` workers. */
export function startOnPool(call: PoolCall, threads: number): PoolHandle {
  const entry: ActiveCall = {
    call,
    docId: nextDocId++,
    inFlight: 0,
    retried: new Set(),
    slots: new Set(),
    released: false,
    drainWaiters: [],
  };
  active.push(entry);
  wake();
  while (slots.length < threads && !disabled) {
    spawn();
  }
  schedule();

  const drain = () =>
    new Promise<void>((resolve) => {
      if (entry.inFlight === 0) {
        resolve();
      } else {
        entry.drainWaiters.push(resolve);
      }
    });

  return {
    drain,
    async release() {
      await drain();
      entry.released = true;
      active = active.filter((other) => other !== entry);
      await Promise.all(
        [...entry.slots].map((slot) =>
          slot.alive
            ? request(slot, { type: "close", docId: entry.docId }).catch(
                () => {},
              )
            : undefined,
        ),
      );
      if (active.length === 0) {
        idle();
      }
    },
  };
}

/** Stops every worker now. */
export function shutdownRenderPool(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  for (const slot of slots) {
    slot.alive = false;
    slot.ready = false;
    void slot.worker.terminate();
  }
  slots = [];
}

function spawn(): void {
  const url = resolveWorkerUrl();
  if (!url) {
    disabled = true;
    return;
  }
  let worker: Worker;
  try {
    worker = new Worker(url, { name: "pdftoimg-js render" });
  } catch {
    disabled = true;
    return;
  }
  const slot: Slot = {
    worker,
    ready: false,
    busy: false,
    alive: true,
    docs: new Map(),
    failedDocs: new Set(),
    pending: new Map(),
  };
  slots.push(slot);
  worker.on("message", (reply: FromWorker) => {
    switch (reply.type) {
      case "ready":
        slot.ready = true;
        schedule();
        break;
      case "opened":
        settle(slot, `open:${reply.docId}`, reply);
        break;
      case "openFailed":
        settle(slot, `open:${reply.docId}`, reply, deserialize(reply.error));
        break;
      case "rendered":
        settle(slot, `job:${reply.jobId}`, reply);
        break;
      case "failed":
        settle(slot, `job:${reply.jobId}`, reply, deserialize(reply.error));
        break;
      case "closed":
        settle(slot, `close:${reply.docId}`, reply);
        break;
    }
  });
  worker.on("error", (error) => die(slot, error));
  worker.on("exit", (code) =>
    die(slot, new Error(`pdftoimg-js render worker exited with code ${code}`)),
  );
}

function die(slot: Slot, error: Error): void {
  if (!slot.alive) {
    return;
  }
  slot.alive = false;
  const wasReady = slot.ready;
  slot.ready = false;
  slots = slots.filter((other) => other !== slot);
  // A worker that never came up is a worker that cannot come up here (the
  // file is broken, or pdf.js cannot load in a thread): stop trying, once
  // the last of them is gone. One still starting may yet show it can be done.
  if (!wasReady && slots.length === 0) {
    disabled = true;
  }
  for (const { reject } of slot.pending.values()) {
    reject(error);
  }
  slot.pending.clear();
  schedule();
}

function settle(slot: Slot, key: string, reply: FromWorker, error?: Error) {
  const pending = slot.pending.get(key);
  if (!pending) {
    return;
  }
  slot.pending.delete(key);
  if (error) {
    pending.reject(error);
  } else {
    pending.resolve(reply);
  }
}

function request(
  slot: Slot,
  message: ToWorker,
  transfer: ArrayBuffer[] = [],
): Promise<FromWorker> {
  return new Promise((resolve, reject) => {
    if (!slot.alive) {
      reject(new Error("pdftoimg-js render worker is gone"));
      return;
    }
    const key =
      message.type === "render"
        ? `job:${message.jobId}`
        : `${message.type}:${message.docId}`;
    slot.pending.set(key, { resolve, reject });
    slot.worker.postMessage(message, transfer);
  });
}

function schedule(): void {
  for (const slot of slots) {
    if (!slot.ready || slot.busy) {
      continue;
    }
    const job = nextJob(slot);
    if (job) {
      void runJob(slot, job.entry, job.pageNumber);
    }
  }
}

/** The next page for this worker, going round the active calls in turn. */
function nextJob(slot: Slot): { entry: ActiveCall; pageNumber: number } | null {
  for (let i = 0; i < active.length; i++) {
    const entry = active[(nextCall + i) % active.length];
    if (entry.released || slot.failedDocs.has(entry.docId)) {
      continue;
    }
    const pageNumber = entry.call.take();
    if (pageNumber !== undefined) {
      nextCall = (nextCall + i + 1) % active.length;
      return { entry, pageNumber };
    }
  }
  return null;
}

async function runJob(
  slot: Slot,
  entry: ActiveCall,
  pageNumber: number,
): Promise<void> {
  slot.busy = true;
  entry.inFlight++;
  try {
    try {
      await openOn(slot, entry);
    } catch {
      // The calling thread opened this document, so a worker that cannot is
      // this worker's problem: leave the document's pages to the others.
      slot.failedDocs.add(entry.docId);
      entry.call.putBack(pageNumber);
      return;
    }
    try {
      const reply = await request(slot, {
        type: "render",
        docId: entry.docId,
        jobId: nextJobId++,
        pageNumber,
        options: entry.call.options,
      });
      entry.call.onResult(pageNumber, (reply as { image: PageImage }).image);
    } catch (error) {
      if (!slot.alive && !entry.retried.has(pageNumber)) {
        // The worker died under the page. Once, someone else renders it.
        entry.retried.add(pageNumber);
        entry.call.putBack(pageNumber);
      } else {
        entry.call.onFailure(error);
      }
    }
  } finally {
    slot.busy = false;
    entry.inFlight--;
    if (entry.inFlight === 0) {
      const waiters = entry.drainWaiters;
      entry.drainWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
    }
    schedule();
  }
}

function openOn(slot: Slot, entry: ActiveCall): Promise<void> {
  let open = slot.docs.get(entry.docId);
  if (!open) {
    const { params, transfer } = entry.call.openParams();
    open = request(
      slot,
      { type: "open", docId: entry.docId, params },
      transfer,
    ).then(() => undefined);
    slot.docs.set(entry.docId, open);
    entry.slots.add(slot);
  }
  return open;
}

function wake(): void {
  clearTimeout(idleTimer);
  idleTimer = undefined;
  for (const slot of slots) {
    slot.worker.ref();
  }
}

/** Nothing to do: let the process exit if it wants to, and stop the workers after a while. */
function idle(): void {
  for (const slot of slots) {
    slot.worker.unref();
  }
  clearTimeout(idleTimer);
  idleTimer = setTimeout(shutdownRenderPool, IDLE_MS);
  idleTimer.unref();
}

function deserialize({ name, message, stack }: SerializedError): Error {
  const error = new Error(message);
  error.name = name;
  if (stack) {
    error.stack = stack;
  }
  return error;
}
