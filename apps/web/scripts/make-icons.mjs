/**
 * Generate the PWA icons.
 *
 * `node scripts/make-icons.mjs` writes the PNGs in `public/`. They are committed, so this is
 * not part of the build — it exists so the icons can be regenerated from a definition rather
 * than re-drawn by hand, and so a change to the brand colour is a one-line edit here instead
 * of an image nobody can diff.
 *
 * The encoder below is about sixty lines because a PNG of flat colour is genuinely that
 * simple: a header, one zlib-compressed block of RGBA scanlines each prefixed with a
 * "no filter" byte, and a terminator. Pulling in an image library to draw four rectangles
 * would be a dependency with a supply chain attached, for this.
 *
 * The mark is three ascending bars — net worth going up — in white on the brand square,
 * kept inside the central 60% so that a maskable icon survives being cropped to a circle on
 * Android.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** sRGB approximations of the brand tokens in `index.css`. */
const BRAND = [0x7a, 0x5a, 0xf8];
const INK = [0xff, 0xff, 0xff];

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

function icon(size, { rounded }) {
  const pixels = Buffer.alloc(size * size * 4);

  // A rounded square, or a full bleed for the maskable variant that Android crops itself.
  const radius = rounded ? size * 0.22 : 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = radius === 0 || insideRoundedRect(x, y, size, radius);
      set(pixels, size, x, y, inside ? BRAND : [0, 0, 0], inside ? 255 : 0);
    }
  }

  // Three bars, ascending, on a shared baseline.
  const baseline = size * 0.72;
  const barWidth = size * 0.11;
  const gap = size * 0.055;
  const left = size * 0.5 - (barWidth * 3 + gap * 2) / 2;

  for (const [index, heightRatio] of [0.16, 0.28, 0.44].entries()) {
    const x0 = Math.round(left + index * (barWidth + gap));
    const y0 = Math.round(baseline - size * heightRatio);
    fill(pixels, size, x0, y0, Math.round(barWidth), Math.round(baseline - y0), INK);
  }

  return encodePng(size, size, pixels);
}

function insideRoundedRect(x, y, size, radius) {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function fill(pixels, size, x0, y0, width, height, colour) {
  for (let y = y0; y < y0 + height; y += 1) {
    for (let x = x0; x < x0 + width; x += 1) {
      if (x >= 0 && y >= 0 && x < size && y < size) set(pixels, size, x, y, colour, 255);
    }
  }
}

function set(pixels, size, x, y, [r, g, b], a) {
  const offset = (y * size + x) * 4;
  pixels[offset] = r;
  pixels[offset + 1] = g;
  pixels[offset + 2] = b;
  pixels[offset + 3] = a;
}

/* -------------------------------------------------------------------------- */
/* PNG                                                                        */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  // 10, 11, 12 stay zero: deflate, adaptive filtering, no interlacing.

  // Each scanline is prefixed with its filter type. Zero — "none" — because flat colour
  // compresses to nothing anyway and the alternatives would only cost cycles.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    raw[start] = 0;
    pixels.copy(raw, start + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------------- */

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" role="img" aria-label="Net Worth">
  <rect width="512" height="512" rx="112" fill="#7a5af8"/>
  <g fill="#ffffff">
    <rect x="169" y="287" width="56" height="82" rx="6"/>
    <rect x="253" y="225" width="56" height="144" rx="6"/>
    <rect x="337" y="143" width="56" height="226" rx="6"/>
  </g>
</svg>
`;

mkdirSync(PUBLIC_DIR, { recursive: true });

for (const [name, size, options] of [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  // Maskable icons are cropped by the launcher, so they bleed to the edge.
  ['icon-maskable-512.png', 512, { rounded: false }],
  // iOS ignores the manifest and looks for this one, and it must not be transparent.
  ['apple-touch-icon.png', 180, { rounded: false }],
]) {
  writeFileSync(join(PUBLIC_DIR, name), icon(size, options));
  process.stdout.write(`wrote ${name}\n`);
}

writeFileSync(join(PUBLIC_DIR, 'icon.svg'), SVG);
process.stdout.write('wrote icon.svg\n');
