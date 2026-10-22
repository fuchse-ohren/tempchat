/** バイナリ・エンコーディング共通（依存なし。client/sw/worker で共有） */

const B64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? B64_ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : "=";
    out += i + 2 < bytes.length ? B64_ALPHABET[b2 & 63] : "=";
  }
  return out;
}

/** 不正文字列は null を返す（例外を使わず検証側に委ねる） */
export function base64ToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length % 4 !== 0 || !B64_RE.test(s)) return null;
  let len = (s.length / 4) * 3;
  if (s.endsWith("==")) len -= 2;
  else if (s.endsWith("=")) len -= 1;
  const out = new Uint8Array(len);
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "=") break;
    const v = B64_ALPHABET.indexOf(c);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === len ? out : null;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (s.length === 0 || !B64URL_RE.test(s)) return null;
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return base64ToBytes(
    s.replace(/-/g, "+").replace(/_/g, "/") + pad,
  );
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

const HEX_RE = /^[0-9a-fA-F]*$/;

/** 不正文字列は null を返す（Number.parseInt の符号・空白・前置許容を避ける） */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) return null;
    out[i] = v;
  }
  return out;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8(s: string): Uint8Array<ArrayBuffer> {
  // workers-types の TextEncoder 型が旧式（汎用なし）のため正規化
  return textEncoder.encode(s) as Uint8Array<ArrayBuffer>;
}

export function utf8Decode(b: Uint8Array): string {
  return textDecoder.decode(b);
}

export function concatBytes(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** D1 の BLOB 読み出しは ArrayBuffer / Uint8Array のいずれかになり得る */
export function toBytes(v: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  // 常に ArrayBuffer 境界のコピーを返す（WebCrypto の型要件 also）
  return new Uint8Array(v instanceof Uint8Array ? v : new Uint8Array(v));
}

export function randomBytes(len: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(len);
  crypto.getRandomValues(b);
  return b;
}
