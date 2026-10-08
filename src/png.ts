import { crc32, deflate, deflateSync } from "node:zlib";

/**
 * A small PNG writer for 8-bit RGBA pixels, as `getImageData` hands them out.
 *
 * It exists because the canvas's own encoder is slow and verbose: skia's PNG
 * encoder takes about 30 ms for an A4 page at 72 dpi and writes it at 230 KB,
 * where the Sub filter with zlib at level 1 takes about 9 ms and writes 200 KB
 * (14 pages of example.pdf: 417 ms and 3.2 MB against 125 ms and 2.8 MB).
 * Level 6 would shave another 10% off the size for three times the time.
 */
const DEFLATE_LEVEL = 1;

const SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);
const IDAT = new Uint8Array([0x49, 0x44, 0x41, 0x54]);
const IEND = new Uint8Array([0x49, 0x45, 0x4e, 0x44]);

/** Encodes the pixels as a PNG, compressing on a libuv thread. */
export async function encodePng(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Promise<Uint8Array> {
  const filtered = filterSub(rgba, width, height);
  const idat = await new Promise<Buffer>((resolve, reject) =>
    deflate(filtered, { level: DEFLATE_LEVEL }, (error, result) =>
      error ? reject(error) : resolve(result),
    ),
  );
  return assemble(width, height, idat);
}

/** Encodes the pixels as a PNG on the calling thread. */
export function encodePngSync(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const filtered = filterSub(rgba, width, height);
  return assemble(
    width,
    height,
    deflateSync(filtered, { level: DEFLATE_LEVEL }),
  );
}

/**
 * Applies the Sub filter (each byte minus the same byte of the pixel to its
 * left, modulo 256) to every row and prefixes each row with its filter type.
 *
 * A pixel is one 32-bit lane, so four bytes are subtracted at once: the high
 * bit of each byte is masked off first and restored after, which keeps a
 * borrow from crossing into the next byte.
 */
function filterSub(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
): Buffer {
  const stride = width * 4;
  if (rgba.byteLength !== stride * height) {
    throw new Error(
      `Expected ${stride * height} bytes of RGBA for ${width}x${height}, got ${rgba.byteLength}`,
    );
  }
  const pixels =
    rgba.byteOffset % 4 === 0
      ? new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
      : new Uint32Array(rgba.slice().buffer);
  const out = Buffer.allocUnsafe((stride + 1) * height);
  const row = new Uint32Array(width);
  const rowBytes = new Uint8Array(row.buffer);
  for (let y = 0; y < height; y++) {
    const first = y * width;
    let left = pixels[first];
    row[0] = left;
    for (let x = 1; x < width; x++) {
      const pixel = pixels[first + x];
      row[x] =
        ((pixel | 0x80808080) - (left & 0x7f7f7f7f)) ^
        ((pixel ^ ~left) & 0x80808080);
      left = pixel;
    }
    const at = y * (stride + 1);
    out[at] = 1;
    out.set(rowBytes, at + 1);
  }
  return out;
}

function assemble(width: number, height: number, idat: Uint8Array): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // compression 0, filter 0, interlace 0

  const png = new Uint8Array(
    SIGNATURE.length + chunkSize(header) + chunkSize(idat) + chunkSize(EMPTY),
  );
  png.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  at = writeChunk(png, at, IHDR, header);
  at = writeChunk(png, at, IDAT, idat);
  writeChunk(png, at, IEND, EMPTY);
  return png;
}

const EMPTY = new Uint8Array(0);

function chunkSize(data: Uint8Array): number {
  return 4 + 4 + data.length + 4;
}

function writeChunk(
  png: Uint8Array,
  at: number,
  type: Uint8Array,
  data: Uint8Array,
): number {
  const view = new DataView(png.buffer, png.byteOffset);
  view.setUint32(at, data.length);
  png.set(type, at + 4);
  png.set(data, at + 8);
  view.setUint32(at + 8 + data.length, crc32(data, crc32(type)));
  return at + chunkSize(data);
}
