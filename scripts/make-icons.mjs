// PWA アイコン（ドット絵の銀行）を PNG で書き出す。依存なし。
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ART = [
  "................",
  ".......YY.......",
  ".....YYYYYY.....",
  "...YYYYYYYYYY...",
  "..WWWWWWWWWWWW..",
  "..W.WW.WW.WW.W..",
  "..W.WW.WW.WW.W..",
  "..W.WW.CC.WW.W..",
  "..W.WW.CC.WW.W..",
  "..W.WW.WW.WW.W..",
  "..W.WW.WW.WW.W..",
  "..WWWWWWWWWWWW..",
  ".GGGGGGGGGGGGGG.",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
  "GGGGGGGGGGGGGGGG",
];
const COLORS = { ".": [47, 111, 78], Y: [242, 193, 78], W: [241, 234, 217], C: [184, 134, 11], G: [124, 179, 66] };

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const scale = size / 16;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b] = COLORS[ART[Math.floor(y / scale)][Math.floor(x / scale)]];
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
mkdirSync("public/icons", { recursive: true });
for (const s of [192, 512]) writeFileSync(`public/icons/icon-${s}.png`, png(s));
console.log("icons written");
