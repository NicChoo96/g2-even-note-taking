// Generates the 24x24 monochrome app icon (SVG + PNG).
// Minimal smart-glasses silhouette — the "G2 Even Reality Hub" brand mark.
// Run: node scripts/gen-icon.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 24;
const H = 24;
const px = new Set();

function rect(x0, y0, x1, y1) {
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) px.add(`${x},${y}`);
}

// ── Smart-glasses silhouette (2px-thick lens walls) ─────────────────────────
// Left lens outline
rect(2, 5, 3, 18);
rect(8, 5, 9, 18);
rect(2, 5, 9, 6);
rect(2, 17, 9, 18);
// Right lens outline
rect(14, 5, 15, 18);
rect(20, 5, 21, 18);
rect(14, 5, 21, 6);
rect(14, 17, 21, 18);
// Bridge (connects the lens top bars across the nose gap)
rect(10, 5, 13, 6);
// Temple arms
rect(0, 8, 1, 10);
rect(22, 8, 23, 10);

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'glasses', 'public');
mkdirSync(outDir, { recursive: true });

// ── SVG (pixel-crisp) ───────────────────────────────────────────────────────
let svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" shape-rendering="crispEdges">\n';
for (const key of px) {
  const [x, y] = key.split(',').map(Number);
  svg += `  <rect x="${x}" y="${y}" width="1" height="1"/>\n`;
}
svg += '</svg>\n';
writeFileSync(join(outDir, 'icon.svg'), svg);

// ── PNG (24x24, truecolour RGBA, black on transparent) ──────────────────────
const stride = W * 4 + 1;
const raw = Buffer.alloc(stride * H);
for (let y = 0; y < H; y++) {
  const row = y * stride;
  raw[row] = 0; // filter: none
  for (let x = 0; x < W; x++) {
    const on = px.has(`${x},${y}`);
    const i = row + 1 + x * 4;
    raw[i] = on ? 0 : 0; // R
    raw[i + 1] = on ? 0 : 0; // G
    raw[i + 2] = on ? 0 : 0; // B
    raw[i + 3] = on ? 255 : 0; // A
  }
}

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
writeFileSync(join(outDir, 'icon.png'), png);

console.log(`Wrote glasses/public/icon.svg (${svg.length} B) and icon.png (${png.length} B)`);
