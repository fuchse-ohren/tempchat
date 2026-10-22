/** E2E 用 PNG 生成（依存なしの Minimal PNG encoder。画像送受信テストの実データ用） */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** 色情報・エッジを含む RGBA 画像を PNG 化する */
export function makePng(width: number, height: number): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 4));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      raw[o++] = (x * 255) / Math.max(1, width - 1);
      raw[o++] = (y * 255) / Math.max(1, height - 1);
      raw[o++] = ((x ^ y) * 254) / Math.max(1, width - 1);
      raw[o++] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export const FIXTURES = {
  photo: resolve("test/e2e/.fixtures/photo.png"),
  big: resolve("test/e2e/.fixtures/photo-large.png"),
};

/** 送信テスト用の実 PNG（縮小・WebP 変換の経路を通すための元画像） */
export function ensureFixtures(): void {
  for (const [path, size] of [
    [FIXTURES.photo, 640],
    [FIXTURES.big, 2560],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, makePng(size, Math.round(size * 0.75)));
  }
}
