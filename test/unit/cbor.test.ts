/**
 * shared/cbor.ts 単体テスト（設計 §10-1「CBORスキーマ検証（長・型・kind・400文字境界）」/
 * 要件 FR-3.1・FR-3.2・FR-4.2、設計 §6.2）
 */
import { decode, encode } from "cbor2";
import { describe, expect, it } from "vitest";
import {
  decodeMessage,
  encodeMessage,
  isName,
  isText,
} from "../../src/shared/cbor.ts";
import type { WireMessage } from "../../src/shared/types.ts";

const ID = "0193a2b3-c4d5-4e6f-8a7b-0c1d2e3f4a5b";

function textMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: ID,
    kind: "text",
    name: "さくら",
    ts: 1766456400000,
    body: "こんにちは",
    ...over,
  };
}

function imageMsg(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    id: ID,
    kind: "image",
    name: "さくら",
    ts: 1766456400000,
    body: { d: "UkVBTENSQVdEQVRBCg==", m: "image/webp", n: "photo.webp" },
    ...over,
  };
}

function decodeRaw(obj: unknown): unknown {
  return decodeMessage(encode(obj) as Uint8Array);
}

describe("スキーマ往復（設計 §6.2）", () => {
  it("テキストメッセージを往復できる", () => {
    const wire: WireMessage = {
      v: 1,
      id: ID,
      kind: "text",
      name: "さくら",
      ts: 1766456400000,
      body: "こんにちは、tempchat",
    };
    const bytes = encodeMessage(wire);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(decodeMessage(bytes)).toEqual(wire);
  });

  it("画像メッセージを往復できる（body は d/m/n）", () => {
    const wire: WireMessage = {
      v: 1,
      id: ID,
      kind: "image",
      name: "ゲスト",
      ts: 1766456400001,
      body: { d: "UkVBTENSQVdEQVRBCg==", m: "image/webp", n: "photo.webp" },
    };
    expect(decodeMessage(encodeMessage(wire))).toEqual(wire);
  });

  it("デコード結果はプレーンな object で、キー順に依存しない（受信側は任意順）", () => {
    const reversed = encode({
      body: "順序不同",
      ts: 1766456400000,
      name: "さくら",
      kind: "text",
      id: ID,
      v: 1,
    }) as Uint8Array;
    expect(decodeMessage(reversed)).toEqual({
      v: 1,
      id: ID,
      kind: "text",
      name: "さくら",
      ts: 1766456400000,
      body: "順序不同",
    });
  });

  it("未知の追加フィールドは除外して返す（内部表現の漏出防止）", () => {
    const out = decodeRaw(textMsg({ evil: "drop", extra: 1 })) as WireMessage;
    expect(Object.keys(out).sort()).toEqual(["body", "id", "kind", "name", "ts", "v"]);
    expect(out.body).toBe("こんにちは");
  });

  it("暗号化前の CBOR は平文である（FR-3.3 の前提確認）", () => {
    const bytes = encodeMessage({
      v: 1,
      id: ID,
      kind: "text",
      name: "平文確認",
      ts: 1766456400000,
      body: "エンコード直後は平文",
    });
    const s = Buffer.from(bytes).toString("utf8");
    expect(s).toContain("平文確認");
    expect(s).toContain("エンコード直後は平文");
  });
});

describe("表示名の境界（FR-3.1: 1〜20文字）", () => {
  it("isName: 1文字〜20文字が true", () => {
    expect(isName("あ")).toBe(true);
    expect(isName("a".repeat(20))).toBe(true);
    expect(isName("")).toBe(false);
    expect(isName("a".repeat(21))).toBe(false);
  });

  it("isName: サロゲートペアはコードポイントで数える", () => {
    expect(isName("🦄".repeat(20))).toBe(true);
    expect(isName("🦄".repeat(21))).toBe(false);
  });

  it("スキーマでも同じ境界を強制する", () => {
    expect(() => decodeRaw(textMsg({ name: "" }))).toThrow(/name/);
    expect(() => decodeRaw(textMsg({ name: "a".repeat(21) }))).toThrow(/name/);
    expect(decodeRaw(textMsg({ name: "a".repeat(20) }))).toBeTruthy();
  });

  it("name が文字列以外なら throw", () => {
    for (const bad of [1, null, true, [], {}, new Uint8Array([1])]) {
      expect(() => decodeRaw(textMsg({ name: bad }))).toThrow(/name/);
    }
  });
});

describe("本文の境界（FR-3.1: 1〜400文字）", () => {
  it("isText: 1文字〜400文字が true", () => {
    expect(isText("a")).toBe(true);
    expect(isText("a".repeat(400))).toBe(true);
    expect(isText("")).toBe(false);
    expect(isText("a".repeat(401))).toBe(false);
  });

  it("isText: サロゲートペアはコードポイントで数える", () => {
    expect(isText("🦄".repeat(400))).toBe(true);
    expect(isText("🦄".repeat(401))).toBe(false);
  });

  it("スキーマでも 400 文字境界を強制する（FR-3.7 クライアント側）", () => {
    expect((decodeRaw(textMsg({ body: "あ".repeat(400) })) as WireMessage).body).toBe("あ".repeat(400));
    expect(() => decodeRaw(textMsg({ body: "あ".repeat(401) }))).toThrow(/body/);
    expect(() => decodeRaw(textMsg({ body: "" }))).toThrow(/body/);
    expect(() => decodeRaw(textMsg({ body: 42 }))).toThrow(/body/);
  });
});

describe("kind と body の整合（FR-3.2 / 免責3 の形式検査）", () => {
  it("kind が text/image 以外は throw", () => {
    for (const bad of ["file", "TEXT", "", 1, null, "image "]) {
      expect(() => decodeRaw(textMsg({ kind: bad }))).toThrow(/kind/);
    }
  });

  it("kind=text で body がオブジェクト（画像形式）なら throw", () => {
    expect(() => decodeRaw(textMsg({ body: { d: "QQ==", m: "image/webp", n: "a.webp" } }))).toThrow(/body/);
  });

  it("kind=image で body が文字列なら throw", () => {
    expect(() => decodeRaw(imageMsg({ body: "text" }))).toThrow(/image body/);
  });

  it("画像 body の必須フィールド検査", () => {
    expect(() => decodeRaw(imageMsg({ body: { m: "image/webp", n: "a.webp" } }))).toThrow(/image data/);
    expect(() => decodeRaw(imageMsg({ body: { d: "", m: "image/webp", n: "a.webp" } }))).toThrow(/image data/);
    expect(() => decodeRaw(imageMsg({ body: { d: 5, m: "image/webp", n: "a.webp" } }))).toThrow(/image data/);
    expect(() => decodeRaw(imageMsg({ body: { d: "QQ==", n: "a.webp" } }))).toThrow(/mime/);
    expect(() => decodeRaw(imageMsg({ body: { d: "QQ==", m: "image/png", n: "a.webp" } }))).toThrow(/mime/);
    expect(() => decodeRaw(imageMsg({ body: { d: "QQ==", m: "image/webp" } }))).toThrow(/image name/);
    expect(() => decodeRaw(imageMsg({ body: { d: "QQ==", m: "image/webp", n: "" } }))).toThrow(/image name/);
    expect(() => decodeRaw(imageMsg({ body: { d: "QQ==", m: "image/webp", n: "a".repeat(65) } }))).toThrow(/image name/);
    expect(decodeRaw(imageMsg({ body: { d: "QQ==", m: "image/webp", n: "a".repeat(64) } }))).toBeTruthy();
  });
});

describe("ヘッダの妥当性（v・id・ts）", () => {
  it("バージョンは 1 のみ受け付ける", () => {
    expect(() => decodeRaw(textMsg({ v: 2 }))).toThrow(/version/);
    expect(() => decodeRaw(textMsg({ v: "1" }))).toThrow(/version/);
    expect(() => decodeRaw(textMsg({ v: 0 }))).toThrow(/version/);
    const noV = textMsg();
    delete noV["v"];
    expect(() => decodeRaw(noV)).toThrow(/version/);
  });

  it("id は 1〜36 文字の文字列（メッセージUUID）", () => {
    expect(() => decodeRaw(textMsg({ id: "" }))).toThrow(/id/);
    expect(() => decodeRaw(textMsg({ id: "a".repeat(37) }))).toThrow(/id/);
    expect(() => decodeRaw(textMsg({ id: 123 }))).toThrow(/id/);
    expect(decodeRaw(textMsg({ id: "a".repeat(36) }))).toBeTruthy();
  });

  it("ts は 1 以上の整数（鍵導出に使う平文メタデータ）", () => {
    expect(() => decodeRaw(textMsg({ ts: 0 }))).toThrow(/ts/);
    expect(() => decodeRaw(textMsg({ ts: -1 }))).toThrow(/ts/);
    expect(() => decodeRaw(textMsg({ ts: 1.5 }))).toThrow(/ts/);
    expect(() => decodeRaw(textMsg({ ts: "1766456400000" }))).toThrow(/ts/);
    expect(() => decodeRaw(textMsg({ ts: null }))).toThrow(/ts/);
    expect((decodeRaw(textMsg({ ts: 1 })) as WireMessage).ts).toBe(1);
  });
});

describe("CBOR として不正な入力（FR-4.2 で破棄）", () => {
  it("map 以外の最上位型は throw", () => {
    for (const v of ["string", 42, [1, 2, 3], true, null]) {
      expect(() => decodeMessage(encode(v) as Uint8Array)).toThrow(/not a map/);
    }
  });

  it("byte string 等の object に見える最上位型もスキーマで弾く", () => {
    expect(() => decodeMessage(encode(new Uint8Array([1, 2])) as Uint8Array)).toThrow();
  });

  it("CBOR として壊れたバイト列は throw（例外型のみ、内容に依存しない）", () => {
    expect(() => decodeMessage(new Uint8Array([0xa0, 0xff]))).toThrow();
    expect(() => decodeMessage(new Uint8Array([]))).toThrow();
    expect(() => decodeMessage(new Uint8Array([0x9b, 0xff]))).toThrow();
  });
});
