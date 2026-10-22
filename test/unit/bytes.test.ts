/**
 * shared/bytes.ts 単体テスト（設計 §10-1「bytes: base64/b64url/hex の往復と不正入力 null」）
 */
import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  base64UrlToBytes,
  bytesToBase64,
  bytesToBase64Url,
  bytesToHex,
  concatBytes,
  hexToBytes,
  randomBytes,
  toBytes,
  utf8,
  utf8Decode,
} from "../../src/shared/bytes.ts";

/** 独立実装（Node Buffer）との突き合わせ用 */
function refBase64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

function seq(len: number, seed = 0): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 37 + seed * 11 + i * i) & 0xff;
  return b;
}

describe("base64", () => {
  it("RFC 4648 の既知ベクター（1バイト刻みの末尾処理）", () => {
    const vectors: [string, string][] = [
      ["", ""],
      ["f", "Zg=="],
      ["fo", "Zm8="],
      ["foo", "Zm9v"],
      ["foob", "Zm9vYg=="],
      ["fooba", "Zm9vYmE="],
      ["foobar", "Zm9vYmFy"],
      ["Man", "TWFu"],
    ];
    for (const [s, b64] of vectors) {
      expect(bytesToBase64(utf8(s))).toBe(b64);
      if (b64 !== "") expect(utf8Decode(base64ToBytes(b64)!)).toBe(s);
    }
  });

  it("全長0〜64バイトで Node の base64 実装と一致し、往復する", () => {
    for (let len = 0; len <= 64; len++) {
      const b = seq(len, len);
      const s = bytesToBase64(b);
      expect(s).toBe(len === 0 ? "" : refBase64(b));
      if (len === 0) continue;
      expect(Array.from(base64ToBytes(s)!)).toEqual(Array.from(b));
    }
  });

  it("全バイト値 0x00〜0xff を含んでも往復する", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    expect(Array.from(base64ToBytes(bytesToBase64(all))!)).toEqual(
      Array.from(all),
    );
  });

  it("不正入力は null（例外は投げない）", () => {
    const bad = [
      "",
      "a",
      "ab",
      "abc",
      "ab*d",
      "ab=d",
      "==",
      "a===",
      "====",
      "/+=",
      "YWJj\n",
      " YWJj",
      "Y=WJ",
    ];
    for (const s of bad) {
      expect(base64ToBytes(s), `expected null for ${JSON.stringify(s)}`).toBeNull();
    }
  });

  it("空でない妥当な入力は必ず非 null", () => {
    expect(base64ToBytes("Zm9vYmFy")).not.toBeNull();
    expect(Array.from(base64ToBytes("Zm9vYmFy")!)).toEqual(
      Array.from(utf8("foobar")),
    );
  });
});

describe("base64url", () => {
  it("パディング無し・英数と -_ のみで出力する", () => {
    expect(bytesToBase64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
    expect(bytesToBase64Url(new Uint8Array([]))).toBe("");
    const s = bytesToBase64Url(seq(32));
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s).toHaveLength(43); // 32B → 43 文字（K_R の招待リンク表現 FR-1.2）
  });

  it("32バイト（K_R 相当）の往復", () => {
    for (let i = 0; i < 20; i++) {
      const b = randomBytes(32);
      expect(Array.from(base64UrlToBytes(bytesToBase64Url(b))!)).toEqual(
        Array.from(b),
      );
    }
  });

  it("全長0〜64バイトで往復する", () => {
    for (let len = 1; len <= 64; len++) {
      const b = seq(len, len + 7);
      expect(Array.from(base64UrlToBytes(bytesToBase64Url(b))!)).toEqual(
        Array.from(b),
      );
    }
  });

  it("不正入力は null（空文字・標準base64記号・パディング込み）", () => {
    for (const bad of ["", "+", "/", "+/", "=", "YWJj=", "a-b+c", "a_b/c", "a b"]) {
      expect(base64UrlToBytes(bad), `expected null for ${JSON.stringify(bad)}`).toBeNull();
    }
  });
});

describe("hex", () => {
  it("0x00〜0xff の往復と小文字正規化", () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i++) all[i] = i;
    const hex = bytesToHex(all);
    expect(hex).toHaveLength(512);
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Array.from(hexToBytes(hex)!)).toEqual(Array.from(all));
  });

  it("SHA-256 ハッシュ文字列（hex64）を 32 バイトに復元する", () => {
    const h = "0".repeat(63) + "f";
    const b = hexToBytes(h);
    expect(b).not.toBeNull();
    expect(b).toHaveLength(32);
    expect(b![31]).toBe(0x0f);
  });

  it("大文字混在の 16 進も受け付ける", () => {
    expect(Array.from(hexToBytes("00FFaAbB")!)).toEqual([0x00, 0xff, 0xaa, 0xbb]);
  });

  it("不正入力は null", () => {
    const bad = [
      "0",
      "z",
      "gg",
      "abc",
      "0x",
      "0 g",
      "ff ee",
      "-1",
      "+1",
      " f",
      "f ",
      "0z",
      "1e+2",
      "0x41",
      "🍣",
    ];
    for (const s of bad) {
      expect(hexToBytes(s), `expected null for ${JSON.stringify(s)}`).toBeNull();
    }
  });

  it("ランダム入力の受理可否が 16 進正規表現と完全に一致する", () => {
    const alphabet = "0123456789abcdefABCDEF xX+_-é🍣";
    for (let i = 0; i < 3000; i++) {
      const len = i % 7;
      let s = "";
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(Math.random() * alphabet.length)]!;
      }
      const valid = s.length % 2 === 0 && /^[0-9a-fA-F]*$/.test(s);
      const got = hexToBytes(s);
      expect(got !== null, `acceptance mismatch for ${JSON.stringify(s)}`).toBe(valid);
      if (got) expect(bytesToHex(got)).toBe(s.toLowerCase());
    }
  });

  it("空文字は長さ0のバイト列", () => {
    expect(hexToBytes("")).toEqual(new Uint8Array(0));
  });
});

describe("utf8 / 結合 / 変換", () => {
  it("日本語・絵文字・制御文字の往復", () => {
    const samples = ["", "さくら", "tempchat-msg-v1:1766456400000", "🦄🍣🐦‍⬛", "a b\t"];
    for (const s of samples) {
      expect(utf8Decode(utf8(s))).toBe(s);
    }
  });

  it("PIN の ASCII 数字は 1バイト/文字になる（FR-1.4）", () => {
    expect(utf8("123456")).toEqual(new Uint8Array([49, 50, 51, 52, 53, 54]));
  });

  it("concatBytes は順序を保つ", () => {
    const c = concatBytes([utf8("ab"), utf8("cde"), new Uint8Array([0])]);
    expect(Array.from(c)).toEqual([97, 98, 99, 100, 101, 0]);
    expect(concatBytes([]).length).toBe(0);
  });

  it("toBytes は ArrayBuffer / Uint8Array どちらからもコピーを作る", () => {
    const src = new Uint8Array([1, 2, 3, 4]);
    const fromBytes = toBytes(src);
    const fromBuffer = toBytes(src.buffer as ArrayBuffer);
    expect(Array.from(fromBytes)).toEqual([1, 2, 3, 4]);
    expect(Array.from(fromBuffer)).toEqual([1, 2, 3, 4]);
    fromBytes[0] = 99;
    fromBuffer[1] = 88;
    expect(Array.from(src)).toEqual([1, 2, 3, 4]); // 元は不変
  });

  it("toBytes は视图（offset/length 付き）の実効範囲だけコピーする", () => {
    const big = new Uint8Array([9, 1, 2, 3, 9]);
    const view = big.subarray(1, 4);
    expect(Array.from(toBytes(view))).toEqual([1, 2, 3]);
  });

  it("randomBytes は長さと一意性を満たす", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const b = randomBytes(12);
      expect(b).toHaveLength(12);
      seen.add(bytesToHex(b));
    }
    expect(seen.size).toBe(500);
    expect(randomBytes(0).length).toBe(0);
  });
});
