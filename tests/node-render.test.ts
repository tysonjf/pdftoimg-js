import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Silences pdf.js's console output for one test and hands back whatever it printed. */
function captureConsole() {
  const spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => {}),
  );
  return () =>
    spies.flatMap((spy) =>
      spy.mock.calls.map((call) => call.map(String).join(" ")),
    );
}
import { pdfToImg, pdfjsDistDir } from "../src/index";
import { describeCanvasFailure } from "../src/pdfjs-node";
import { dataUrlToPng, decodePng, hasInk } from "./helpers";

const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const examplePdf = fileURLToPath(
  new URL("../example/example.pdf", import.meta.url),
);

// helvetica.pdf is a 200x100pt page: "Hello" in non-embedded Helvetica at 36pt
// with its baseline at y=40 (PDF coordinates, origin bottom-left) and a blue
// 30x30 square at x 150..180, y 20..50. Nothing paints the background.
const TEXT_BOX = { x: 20, y: 36, w: 90, h: 26 };
const SQUARE = { x: 165, y: 65 };
const CORNER = { x: 2, y: 2 };

describe("pdfToImg in Node", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders a page with embedded fonts to a PNG data URL", async () => {
    const dataUrl = await pdfToImg(new Uint8Array(await readFile(examplePdf)), {
      pages: "firstPage",
      scale: 0.5,
    });
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect(px.width).toBeGreaterThan(100);
    expect(px.height).toBeGreaterThan(100);
  });

  it("accepts a Buffer, an ArrayBuffer and a file path alike", async () => {
    const buffer = await readFile(examplePdf);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    );
    const [fromBuffer, fromArrayBuffer, fromPath] = await Promise.all([
      pdfToImg(buffer, { pages: 1, scale: 0.25 }),
      pdfToImg(arrayBuffer, { pages: 1, scale: 0.25 }),
      pdfToImg(examplePdf, { pages: 1, scale: 0.25 }),
    ]);
    expect(fromBuffer).toBe(fromArrayBuffer);
    expect(fromBuffer).toBe(fromPath);
  });

  it("finds the standard fonts in the installed pdfjs-dist", async () => {
    const dir = pdfjsDistDir();
    expect(dir).not.toBeNull();
    expect(
      existsSync(join(dir!, "standard_fonts", "LiberationSans-Regular.ttf")),
    ).toBe(true);
    expect(existsSync(join(dir!, "cmaps", "Adobe-Japan1-UCS2.bcmap"))).toBe(
      true,
    );
    expect(existsSync(join(dir!, "wasm", "openjpeg.wasm"))).toBe(true);
  });

  it("draws non-embedded Helvetica from the standard fonts without a warning", async () => {
    const printed = captureConsole();
    const dataUrl = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      {
        pages: "firstPage",
      },
    );
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect([px.width, px.height]).toEqual([200, 100]);
    expect(hasInk(px, TEXT_BOX)).toBe(true);
    expect(px.at(SQUARE.x, SQUARE.y)).toEqual([0, 0, 255, 255]);
    expect(printed().filter((m) => m.startsWith("Warning:"))).toEqual([]);
  });

  it("warns (and does not throw) when the standard fonts cannot be read", async () => {
    const printed = captureConsole();
    await pdfToImg(new Uint8Array(await readFile(fixture("helvetica.pdf"))), {
      pages: "firstPage",
      documentOptions: { standardFontDataUrl: "/nonexistent/standard_fonts/" },
    });
    expect(
      printed().some((m) => /Unable to load font data|standard ?font/i.test(m)),
    ).toBe(true);
  });

  it("paints the page white by default", async () => {
    const dataUrl = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      {
        pages: "firstPage",
      },
    );
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect(px.at(CORNER.x, CORNER.y)).toEqual([255, 255, 255, 255]);
  });

  it("keeps the page transparent with background rgba(0,0,0,0)", async () => {
    const dataUrl = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      {
        pages: "firstPage",
        background: "rgba(0,0,0,0)",
      },
    );
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect(px.at(CORNER.x, CORNER.y)[3]).toBe(0);
    expect(px.at(SQUARE.x, SQUARE.y)).toEqual([0, 0, 255, 255]);
    expect(hasInk(px, TEXT_BOX)).toBe(true);
  });

  it("keeps the page transparent with the CSS keyword transparent", async () => {
    const dataUrl = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      {
        pages: "firstPage",
        background: "transparent",
      },
    );
    const px = await decodePng(dataUrlToPng(dataUrl));
    expect(px.at(CORNER.x, CORNER.y)[3]).toBe(0);
  });

  it("returns bytes with the pixel size and page number when asked", async () => {
    const bytes = new Uint8Array(await readFile(fixture("helvetica.pdf")));
    const [image, dataUrl] = await Promise.all([
      pdfToImg(bytes, { pages: 1, returnType: "bytes" }),
      pdfToImg(bytes, { pages: 1 }),
    ]);
    expect(image.pageNumber).toBe(1);
    expect([image.width, image.height]).toEqual([200, 100]);
    expect(image.mime).toBe("image/png");
    // PNG signature, and a plain Uint8Array rather than a Node Buffer.
    expect(Array.from(image.bytes.slice(0, 4))).toEqual([
      0x89, 0x50, 0x4e, 0x47,
    ]);
    expect(Buffer.isBuffer(image.bytes)).toBe(false);
    // Same pixels as the data URL path.
    const fromBytes = await decodePng(Buffer.from(image.bytes));
    const fromDataUrl = await decodePng(dataUrlToPng(dataUrl));
    expect(fromBytes.at(SQUARE.x, SQUARE.y)).toEqual(
      fromDataUrl.at(SQUARE.x, SQUARE.y),
    );
    expect(fromBytes.at(CORNER.x, CORNER.y)).toEqual([255, 255, 255, 255]);
  });

  it("encodes JPEG bytes when imgType is jpg", async () => {
    const image = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      {
        pages: 1,
        imgType: "jpg",
        returnType: "bytes",
      },
    );
    expect(image.mime).toBe("image/jpeg");
    expect(Array.from(image.bytes.slice(0, 2))).toEqual([0xff, 0xd8]);
  });

  it("keeps page order and page numbers for a page list", async () => {
    const images = await pdfToImg(new Uint8Array(await readFile(examplePdf)), {
      pages: [3, 1],
      scale: 0.25,
      returnType: "bytes",
    });
    expect(images.map((i) => i.pageNumber)).toEqual([3, 1]);
    for (const image of images) {
      expect(image.width).toBeGreaterThan(0);
      expect(image.bytes.length).toBeGreaterThan(0);
    }
  });

  it("rejects, instead of crashing the process, when a page fails to encode", async () => {
    const { createCanvas } = await import("@napi-rs/canvas");
    type Made = { canvas: ReturnType<typeof createCanvas> };
    // pdf.js's canvas factory contract, with canvases whose encode fails at
    // once: page 1's encode rejects while page 2 is still rendering.
    class FailingEncodeFactory {
      create(width: number, height: number) {
        const canvas = createCanvas(width, height);
        (canvas as { encode: unknown }).encode = () =>
          Promise.reject(new Error("encode failed"));
        return { canvas, context: canvas.getContext("2d") };
      }
      reset({ canvas }: Made, width: number, height: number) {
        canvas.width = width;
        canvas.height = height;
      }
      destroy({ canvas }: Made) {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    await expect(
      pdfToImg(new Uint8Array(await readFile(examplePdf)), {
        pages: [1, 2, 3],
        scale: 0.25,
        returnType: "bytes",
        documentOptions: { CanvasFactory: FailingEncodeFactory },
      }),
    ).rejects.toThrow("encode failed");
  });

  it("says the scale is too small, rather than blaming the canvas, for scale 0", async () => {
    const error = await pdfToImg(
      new Uint8Array(await readFile(fixture("helvetica.pdf"))),
      { pages: 1, scale: 0 },
    ).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/at least 1x1 px/);
    expect((error as Error).message).not.toMatch(/napi-rs/);
  });

  it("returns one image per page for 'all' and a single image for a page number", async () => {
    const bytes = new Uint8Array(await readFile(fixture("helvetica.pdf")));
    const all = await pdfToImg(bytes, { pages: "all", scale: 0.5 });
    const one = await pdfToImg(bytes, { pages: 1, scale: 0.5 });
    expect(Array.isArray(all)).toBe(true);
    expect(all).toHaveLength(1);
    expect(one).toBe(all[0]);
  });
});

describe("describeCanvasFailure", () => {
  const missingModule = Object.assign(
    new Error("Cannot find module '@napi-rs/canvas'\nRequire stack: ..."),
    { code: "MODULE_NOT_FOUND" },
  );
  const otherModule = Object.assign(
    new Error("Cannot find module 'left-pad'"),
    {
      code: "MODULE_NOT_FOUND",
    },
  );

  it.each([
    ["a missing @napi-rs/canvas", missingModule],
    ["a missing platform binary", new Error("Cannot find native binding.")],
    [
      "an unpolyfilled DOMMatrix",
      new ReferenceError("DOMMatrix is not defined"),
    ],
  ])("explains %s", (_, error) => {
    expect(describeCanvasFailure(error).message).toMatch(
      /needs @napi-rs\/canvas[\s\S]*externalPackages/,
    );
  });

  it.each([
    ["pdf.js's empty-canvas check", new Error("Invalid canvas size")],
    ["some other missing module", otherModule],
    [
      "an unrelated ReferenceError",
      new ReferenceError("canvas is not defined"),
    ],
  ])("passes %s through untouched", (_, error) => {
    expect(describeCanvasFailure(error)).toBe(error);
  });
});
