/**
 * shared/crypto.ts 単体テスト（設計 §10-1「既知入力の回帰ベクター・
 * AAD改ざん検知・IV一意性」/ 要件 SEC-1）
 * 期待値は Node の別実装（node:crypto）で算出した既知ベクターであり、
 * WebCrypto 実装側の自己参照にはなっていない。
 */
import { randomBytes as nodeRandom, createHash, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptMessage,
  deriveMessageKey,
  encryptMessage,
  roomAuthHash,
} from "../../src/shared/crypto.ts";
import { bytesToHex, utf8 } from "../../src/shared/bytes.ts";

/** K_R = 0x00..0x1f（既知ベクター用） */
const KR = new Uint8Array(32).map((_, i) => i);
const KR_ALT = new Uint8Array(32).fill(0xab);
const TS = 1766456400000;

function arrEq(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

describe("roomAuthHash = SHA-256(K_R ‖ utf8(PIN))（FR-1.4 / SEC-1）", () => {
  it("既知ベクター（node:crypto で算出した hex64 と一致）", async () => {
    expect(await roomAuthHash(KR, "123456")).toBe(
      "b274cdaf9d807a8dcd345a813cf92c7b86917d4bdfd2f9d99831b2560c486f7f",
    );
    expect(await roomAuthHash(KR, "000000")).toBe(
      "367ec77fa7e25cc3873377ff12a89739add1859021db5fe2b7e28f8929e983fa",
    );
    expect(await roomAuthHash(KR, "")).toBe(
      "630dcd2966c4336691125448bbb25b4ff412a49c732db2c8abc1b8581bd710dd",
    );
    expect(await roomAuthHash(KR_ALT, "9876543210")).toBe(
      "079417449940616df952e1a8676facc06711cc0f1ceac5de563c6b016310ddcd",
    );
  });

  it("入力の1ビット違いでハッシュが変わる（雪崩）", async () => {
    const a = await roomAuthHash(KR, "123456");
    const b = await roomAuthHash(KR, "123457");
    const kr2 = KR.slice();
    kr2[31] = 0xe0;
    const c = await roomAuthHash(kr2, "123456");
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it("出力は常に 64 文字の小文字 16 進", async () => {
    for (let i = 0; i < 5; i++) {
      const kr = new Uint8Array(nodeRandom(32));
      expect(await roomAuthHash(kr, String(100000 + i))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("K_R と PIN の境界（連結順）が変わらない", async () => {
    // SHA-256(K_R ‖ PIN) であり SHA-256(PIN ‖ K_R) ではない
    const pin = "123456";
    const wrong = createHash("sha256")
      .update(Buffer.concat([Buffer.from(pin), Buffer.from(KR)]))
      .digest("hex");
    expect(await roomAuthHash(KR, pin)).not.toBe(wrong);
  });
});

describe("deriveMessageKey = HKDF-SHA-256(ikm=K_R, salt=PIN, info=\"tempchat-msg-v1:\"+ts)（SEC-1）", () => {
  /** node の HKDF で独立算出した鍵と、導出鍵で作った暗号文が相互運用することを確認する */
  async function nodeKey(pin: string, ts: number, info = `tempchat-msg-v1:${ts}`): Promise<CryptoKey> {
    const raw = Buffer.from(hkdfSync("sha256", Buffer.from(KR), Buffer.from(pin, "utf8"), Buffer.from(info, "utf8"), 32));
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  }

  it("導出鍵は node の HKDF（info=PREFIX+ts）と一致する", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const plain = utf8("既知ベクター回帰 🦄");
    const blob = await encryptMessage(key, TS, plain);
    const iv = blob.slice(0, 12);
    const refKey = await nodeKey("123456", TS);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: utf8(String(TS)) },
      refKey,
      blob.slice(12),
    );
    expect(arrEq(new Uint8Array(out), plain)).toBe(true);
  });

  it("info の書式（コロン区切り・プレフィックス）が仕様通り", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const blob = await encryptMessage(key, TS, utf8("x"));
    // 誤った info（コロン無し）で導出した鍵では復号できない
    const badKey = await nodeKey("123456", TS, `tempchat-msg-v1${TS}`);
    await expect(
      crypto.subtle.decrypt(
        { name: "AES-GCM", iv: blob.slice(0, 12), additionalData: utf8(String(TS)) },
        badKey,
        blob.slice(12),
      ),
    ).rejects.toThrow();
  });

  it("same input → same key（決定性）", async () => {
    const k1 = await deriveMessageKey(KR, "123456", TS);
    const k2 = await deriveMessageKey(KR, "123456", TS);
    const blob = await encryptMessage(k1, TS, utf8("決定性チェック"));
    expect(arrEq(await decryptMessage(k2, TS, blob), utf8("決定性チェック"))).toBe(true);
  });

  it("ts が違えば別鍵（異なる ts の鍵では復号できない）", async () => {
    const k1 = await deriveMessageKey(KR, "123456", TS);
    const k2 = await deriveMessageKey(KR, "123456", TS + 1);
    const blob = await encryptMessage(k1, TS, utf8("タイムスタンプ境界"));
    await expect(decryptMessage(k2, TS, blob)).rejects.toThrow();
  });

  it("PIN が違えば別鍵", async () => {
    const k1 = await deriveMessageKey(KR, "123456", TS);
    const k2 = await deriveMessageKey(KR, "123457", TS);
    const blob = await encryptMessage(k1, TS, utf8("PIN境界"));
    await expect(decryptMessage(k2, TS, blob)).rejects.toThrow();
  });

  it("既知の HKDF 出力バイト列（32B）と一致する回帰", async () => {
    // 期待値は node:crypto hkdfSync で算出
    const expectHex = (pin: string, ts: number) =>
      Buffer.from(hkdfSync("sha256", Buffer.from(KR), Buffer.from(pin), Buffer.from(`tempchat-msg-v1:${ts}`), 32));
    expect(expectHex("123456", TS).toString("hex")).toBe(
      "f4fb623df9dee9337d1589c36bab1b28d26c24c642fa17677ef484512a189089",
    );
    expect(expectHex("123456", TS + 1).toString("hex")).toBe(
      "f1bd0615644300027e1e5e2a55b336788bce1d0e3d8455ed2f88a3bf464ed7ac",
    );
    expect(expectHex("654321", TS).toString("hex")).toBe(
      "91b68827d30e0b103a72d1e561b4714c91888b284363653e70534d52f8e093a2",
    );
  });
});

describe("encryptMessage / decryptMessage（AES-256-GCM・IV‖密文‖tag・AAD=ts）", () => {
  it("平文種別を問わず往復する", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const cases: (string | Uint8Array)[] = [
      "hello",
      "さくらのメッセージ 🦄",
      "a".repeat(1200),
      "\u0000\u0001\u0002",
    ];
    for (const c of cases) {
      const pt = typeof c === "string" ? utf8(c) : c;
      const blob = await encryptMessage(key, TS, pt);
      expect(arrEq(await decryptMessage(key, TS, blob), pt)).toBe(true);
    }
  });

  it("空平文も往復する", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const blob = await encryptMessage(key, TS, new Uint8Array(0));
    expect(blob).toHaveLength(12 + 16);
    expect(await decryptMessage(key, TS, blob)).toHaveLength(0);
  });

  it("出力は IV(12B)‖暗号文‖tag(16B) の長さになる", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    for (const n of [1, 17, 300, 1500]) {
      const pt = new Uint8Array(n).fill(0x41);
      const blob = await encryptMessage(key, TS, pt);
      expect(blob).toHaveLength(12 + n + 16);
    }
  });

  it("IV はメッセージごとに一意で、暗号文の先頭 12 バイトである", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const pt = utf8("同じ平文を何度暗号化しても別IV（SEC-1）");
    const ivs = new Set<string>();
    const blobs: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      const blob = await encryptMessage(key, TS, pt);
      ivs.add(bytesToHex(blob.slice(0, 12)));
      blobs.push(blob);
    }
    expect(ivs.size).toBe(200);
    // IV が違えば密文も違う（同一平文の暗号文一致なし）
    const cts = new Set(blobs.map((b) => bytesToHex(b.slice(12))));
    expect(cts.size).toBe(200);
    // 先頭12バイトが IV であり、そこから正しく復号できる
    const first = blobs[0]!;
    expect(await decryptMessage(key, TS, first)).toHaveLength(pt.length);
  });

  it("AAD（平文メタデータ ts）の入れ替え改ざんを検知する（設計 §6.1）", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const blob = await encryptMessage(key, TS, utf8("ts バインディング"));
    await expect(decryptMessage(key, TS + 1, blob)).rejects.toThrow();
    await expect(decryptMessage(key, TS - 1, blob)).rejects.toThrow();
    // 正しい ts なら復号できる（= 上記の失敗は AAD によるもの）
    expect(await decryptMessage(key, TS, blob)).toHaveLength(utf8("ts バインディング").length);
  });

  it("暗号文・IV・タグの1バイト改ざんを検知する", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const blob = await encryptMessage(key, TS, utf8("改ざん検知の検証"));
    for (const offset of [0, 6, 12, 20, blob.length - 1]) {
      const tampered = blob.slice();
      tampered[offset] = (tampered[offset]! + 1) & 0xff;
      await expect(decryptMessage(key, TS, tampered), `offset ${offset}`).rejects.toThrow();
    }
  });

  it("タグ切断など短すぎる暗号文は throw（FR-4.2 で破棄される）", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    for (const short of [new Uint8Array(0), new Uint8Array(11), new Uint8Array(12), new Uint8Array(27)]) {
      await expect(decryptMessage(key, TS, short)).rejects.toThrow();
    }
  });

  it("他人の鍵（別ルーム）では復号できない", async () => {
    const key = await deriveMessageKey(KR, "123456", TS);
    const other = await deriveMessageKey(KR_ALT, "123456", TS);
    const blob = await encryptMessage(key, TS, utf8("部外者"));
    await expect(decryptMessage(other, TS, blob)).rejects.toThrow();
  });
});
