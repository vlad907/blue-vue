// Draws build/icon.png (1024x1024): a 2x2 video wall on a dark rounded tile.
// electron-builder turns it into the Mac .icns. Run: node build/make-icon.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const S = 1024;
const px = Buffer.alloc(S * S * 4);
const inRounded = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
// Mac icons sit inside a 824px tile with transparent margins.
const T0 = 100, T1 = 924;
const tiles = [];
const g = 28, w0 = 250, w1 = 774, half = (w1 - w0 - g) / 2;
for (const r of [0, 1]) for (const c of [0, 1]) tiles.push([w0 + c * (half + g), 300 + r * (180 + g), w0 + c * (half + g) + half, 300 + r * (180 + g) + 180]);
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  let rgba = [0, 0, 0, 0];
  if (inRounded(x, y, T0, T0, T1, T1, 185)) {
    const t = (y - T0) / (T1 - T0);
    rgba = [Math.round(19 - 8 * t), Math.round(28 - 10 * t), Math.round(46 - 14 * t), 255];
    for (const [a, b, c, d] of tiles) if (inRounded(x, y, a, b, c, d, 18)) {
      const k = (x - a) / (c - a) * 0.5 + (y - b) / (d - b) * 0.5;
      rgba = [Math.round(59 + (96 - 59) * k), Math.round(130 + (165 - 130) * k), Math.round(246 + (250 - 246) * k), 255];
    }
    if (inRounded(x, y, 452, 712, 572, 736, 12)) rgba = [138, 155, 184, 255]; // stand
  }
  px.set(rgba, (y * S + x) * 4);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const v of b) c = crcTable[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
writeFileSync(new URL("./icon.png", import.meta.url), Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
