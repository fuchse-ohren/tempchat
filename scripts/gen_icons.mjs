/**
 * PWA アイコン PNG 生成スクリプト（依存なし・node のみ）
 * 角丸レクタ + チャットバブル + 3ドット を描画して public/icon-{192,512}.png を出力する。
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Uint32Array(256).map((_, n) => {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      return v >>> 0;
    });
  }
  c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "ascii"), data])), 8 + data.length);
  return out;
}

/** 角丸レクタ内か */
function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || y < y0 || x > x0 + w || y > y0 + h) return false;
  const cx = Math.max(x0 + r, Math.min(x, x0 + w - r));
  const cy = Math.max(y0 + r, Math.min(y, y0 + h - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x0 + w - r) || (y >= y0 + r && y <= y0 + h - r);
}
function inCircle(x, y, cx, cy, r) {
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function inTriangle(x, y, pts) {
  const [a, b, c] = pts;
  const s = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / 2
          + ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / 2;
  const t = ((a[1] - b[1]) * (x - b[0]) + (b[0] - a[0]) * (y - a[1])) / 2;
  const neg = s < 0 || t < 0;
  const nneg = s > 0 || t > 0;
  return !(neg && nneg) && !((s === 0 && t === 0) ? false : false);
}

function px(u, v, size) {
  // 0..1 座標 → 色 [r,g,b,a]（3x3 スーパーサンプリング）
  const mix = (samples) => {
    let r = 0, g = 0, b = 0, a = 0;
    for (const s of samples) { r += s[0]; g += s[1]; b += s[2]; a += s[3]; }
    const n = samples.length;
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
  };
  const colorAt = (x, y) => {
    const S = size;
    const bg = [79, 124, 255, 255]; // #4f7cff
    const clear = [0, 0, 0, 0];
    // 背景: 角丸レクタ (0.04S 幅、r=0.18S)
    if (!inRoundRect(x, y, 0.04 * S, 0.04 * S, 0.92 * S, 0.92 * S, 0.18 * S)) return clear;
    let col = bg;
    // バブル: 白 角丸 (0.16..0.84, 0.22..0.62)
    if (inRoundRect(x, y, 0.16 * S, 0.22 * S, 0.68 * S, 0.4 * S, 0.12 * S)) col = [255, 255, 255, 255];
    // バブルの尻尾
    if (inTriangle(x, y, [[0.3 * S, 0.6 * S], [0.46 * S, 0.6 * S], [0.3 * S, 0.76 * S]])) col = [255, 255, 255, 255];
    // 2本目の線
    if (inRoundRect(x, y, 0.2 * S, 0.5 * S, 0.6 * S, 0.24 * S, 0.1 * S)) col = [233, 238, 246, 255];
    // ドット（1本目の線）
    const dotY = 0.34 * S;
    const r0 = 0.035 * S;
    for (const dx of [0.3, 0.5, 0.7]) {
      if (inCircle(x, y, dx * S, dotY, r0)) col = [79, 124, 255, 255];
    }
    // 2本目の線内ドット
    const dotY2 = 0.62 * S;
    for (const dx of [0.32, 0.48]) {
      if (inCircle(x, y, dx * S, dotY2, r0)) col = [79, 124, 255, 255];
    }
    return col;
  };
  const samples = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      samples.push(colorAt(u + dx / 3, v + dy / 3));
    }
  }
  return mix(samples);
}

function makePng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: None
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const png = makePng(size);
  const path = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(path, png);
  console.log("wrote", path.pathname, png.length, "bytes");
}
