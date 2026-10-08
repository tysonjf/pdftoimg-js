import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pdfToImg } from "../src/index";
import {
  defaultThreads,
  isPlainData,
  poolAvailable,
  setRenderWorkerUrl,
  shutdownRenderPool,
} from "../src/pool";
import { buildRenderWorker, decodePng } from "./helpers";

const examplePdf = fileURLToPath(
  new URL("../example/example.pdf", import.meta.url),
);
const helveticaPdf = fileURLToPath(
  new URL("./fixtures/helvetica.pdf", import.meta.url),
);

describe("the render pool", () => {
  let bytes: Uint8Array;

  beforeAll(async () => {
    bytes = new Uint8Array(await readFile(examplePdf));
    setRenderWorkerUrl(await buildRenderWorker());
  });
  afterAll(() => {
    shutdownRenderPool();
    setRenderWorkerUrl(undefined);
  });

  it("is available once the worker file is known", () => {
    expect(poolAvailable()).toBe(true);
    expect(defaultThreads()).toBe(
      Math.max(0, Math.min(availableParallelism() - 1, 4)),
    );
  });

  it("renders the same bytes on worker threads as on the calling thread", async () => {
    const [pooled, alone] = await Promise.all([
      pdfToImg(bytes, {
        pages: "all",
        scale: 0.5,
        returnType: "bytes",
        threads: 3,
      }),
      pdfToImg(bytes, {
        pages: "all",
        scale: 0.5,
        returnType: "bytes",
        threads: 0,
      }),
    ]);
    expect(pooled).toHaveLength(14);
    expect(pooled.map((i) => i.pageNumber)).toEqual(
      alone.map((i) => i.pageNumber),
    );
    for (let i = 0; i < pooled.length; i++) {
      expect(pooled[i].width).toBe(alone[i].width);
      expect(Buffer.isBuffer(pooled[i].bytes)).toBe(false);
      // Rendering and the PNG writer are deterministic, so a page comes out
      // byte for byte the same whichever thread drew it.
      expect(Buffer.from(pooled[i].bytes).equals(alone[i].bytes)).toBe(true);
    }
  });

  it("keeps page order, page numbers and duplicates for a page list", async () => {
    const images = await pdfToImg(bytes, {
      pages: [3, 1, 3, 2],
      scale: 0.25,
      returnType: "bytes",
      threads: 2,
    });
    expect(images.map((i) => i.pageNumber)).toEqual([3, 1, 3, 2]);
    expect(images[0]).toBe(images[2]);
  });

  it("returns data URLs by default, decodable and in order", async () => {
    const urls = await pdfToImg(bytes, {
      pages: { startPage: 1, endPage: 4 },
      scale: 0.25,
      threads: 2,
    });
    expect(urls).toHaveLength(4);
    for (const url of urls) {
      expect(url.startsWith("data:image/png;base64,")).toBe(true);
      const px = await decodePng(
        Buffer.from(url.slice(url.indexOf(",") + 1), "base64"),
      );
      expect(px.width).toBeGreaterThan(100);
    }
  });

  it("encodes JPEGs on the workers too", async () => {
    const images = await pdfToImg(bytes, {
      pages: [1, 2, 3],
      scale: 0.25,
      imgType: "jpg",
      returnType: "bytes",
      threads: 2,
    });
    for (const image of images) {
      expect(image.mime).toBe("image/jpeg");
      expect(Array.from(image.bytes.slice(0, 2))).toEqual([0xff, 0xd8]);
    }
  });

  it("renders several documents at once through the same workers", async () => {
    const helvetica = new Uint8Array(await readFile(helveticaPdf));
    const [a, b, c] = await pdfToImg([bytes, helveticaPdf, helvetica], {
      pages: { startPage: 1 },
      scale: 0.2,
      returnType: "bytes",
      threads: 3,
    });
    expect(a.map((i) => i.pageNumber)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    expect(b.map((i) => i.pageNumber)).toEqual([1]);
    expect(c.map((i) => i.pageNumber)).toEqual([1]);
    expect(Buffer.from(b[0].bytes).equals(c[0].bytes)).toBe(true);
  });

  it("rejects with a page's error from a worker, and keeps working afterwards", async () => {
    // maxWidth below a pixel fails inside renderPage, on whichever thread
    // takes the page, with the message the calling thread would give.
    await expect(
      pdfToImg(bytes, {
        pages: "all",
        maxWidth: 0.5,
        returnType: "bytes",
        threads: 3,
      }),
    ).rejects.toThrow(/at least 1x1 px/);
    const again = await pdfToImg(bytes, {
      pages: [1, 2],
      scale: 0.25,
      returnType: "bytes",
      threads: 3,
    });
    expect(again.map((i) => i.pageNumber)).toEqual([1, 2]);
  });

  it("stays on the calling thread for options that cannot cross threads", () => {
    class SomeFactory {}
    expect(
      isPlainData({ documentOptions: { CanvasFactory: SomeFactory } }),
    ).toBe(false);
    expect(
      isPlainData({
        documentOptions: { password: "x" },
        pages: [1, 2],
        background: "transparent",
      }),
    ).toBe(true);
    expect(isPlainData({ background: new URL("https://a.test/") })).toBe(false);
    expect(
      isPlainData({
        data: new Uint8Array(2),
        nested: { list: [1, "a", null] },
      }),
    ).toBe(true);
  });
});
