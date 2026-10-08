import { describe, expect, it } from "vitest";
import { encodePng, encodePngSync } from "../src/png";
import { inflateSync } from "node:zlib";
import { decodePng } from "./helpers";

/** Decodes what encodePng writes: 8-bit RGBA, one IDAT, every row Sub-filtered. */
function unfilter(png: Uint8Array): Uint8ClampedArray {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  expect([png[24], png[25]]).toEqual([8, 6]);
  const idatLength = view.getUint32(33);
  expect(Buffer.from(png.subarray(37, 41)).toString("latin1")).toBe("IDAT");
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  const stride = width * 4;
  const out = new Uint8ClampedArray(stride * height);
  for (let y = 0; y < height; y++) {
    expect(raw[y * (stride + 1)]).toBe(1);
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      out[y * stride + x] =
        (row[x] + (x >= 4 ? out[y * stride + x - 4] : 0)) & 255;
    }
  }
  return out;
}

function pixels(width: number, height: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      // Gradients in every channel, a hard edge, and alpha that varies.
      data[i] = (x * 7) & 255;
      data[i + 1] = (y * 13) & 255;
      data[i + 2] = x > width / 2 ? 255 : 0;
      data[i + 3] = y < height / 3 ? 255 : (x * 3) & 255;
    }
  }
  return data;
}

describe("encodePng", () => {
  it("writes a PNG that decodes to the same pixels, alpha included", async () => {
    const [width, height] = [97, 41];
    const data = pixels(width, height);
    const png = await encodePng(data, width, height);
    expect(Array.from(png.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(Buffer.isBuffer(png)).toBe(false);
    expect(unfilter(png)).toEqual(data);
  });

  it("is accepted by the canvas's own decoder", async () => {
    const [width, height] = [97, 41];
    const data = pixels(width, height);
    const decoded = await decodePng(
      Buffer.from(await encodePng(data, width, height)),
    );
    expect([decoded.width, decoded.height]).toEqual([width, height]);
    // The canvas premultiplies on load, so only opaque pixels come back exact.
    for (const [x, y] of [
      [0, 0],
      [5, 2],
      [60, 12],
      [96, 13],
    ]) {
      const i = (y * width + x) * 4;
      expect(decoded.at(x, y)).toEqual(Array.from(data.slice(i, i + 4)));
    }
  });

  it("gives the same bytes from the sync and async encoders", async () => {
    const [width, height] = [64, 8];
    const data = pixels(width, height);
    expect(encodePngSync(data, width, height)).toEqual(
      await encodePng(data, width, height),
    );
  });

  it("accepts a view that does not start on a 4-byte boundary", async () => {
    const [width, height] = [5, 3];
    const data = pixels(width, height);
    const padded = new Uint8Array(data.length + 2);
    padded.set(data, 2);
    const view = new Uint8Array(padded.buffer, 2, data.length);
    expect(await encodePng(view, width, height)).toEqual(
      await encodePng(data, width, height),
    );
  });

  it("refuses pixels of the wrong size", () => {
    expect(() => encodePngSync(new Uint8ClampedArray(12), 2, 2)).toThrow(
      /16 bytes/,
    );
  });
});
