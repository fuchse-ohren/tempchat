/**
 * 認証境界の統合テスト（設計 §10-2「認証境界（403/404）」/ FR-1.4・FR-2.2・FR-4.3）
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALT_PIN,
  applySchema,
  bytesToHex,
  call,
  db,
  fakeCt,
  hexToBytes,
  insertMessage,
  insertSub,
  randomBytes,
  roomAuthHash,
  seedRoom,
  UUID_A,
  UUID_B,
} from "./helpers.ts";
import { constantTimeEqualHex } from "../../src/worker/util.ts";

beforeEach(async () => {
  await applySchema();
});

const ENDPOINTS = (roomId: string) => [
  ["POST", `/api/rooms/${roomId}/join`, undefined],
  ["GET", `/api/rooms/${roomId}/messages`, undefined],
  ["POST", `/api/rooms/${roomId}/messages`, { ts: Date.now(), kind: "text", ct: "AAAAAAAA" }],
  ["GET", `/api/rooms/${roomId}/messages/1/data`, undefined],
  ["PUT", `/api/rooms/${roomId}/subscription`, { endpoint: "https://push.example/x", p256dh: "p", auth: "a" }],
  ["DELETE", `/api/rooms/${roomId}/subscription`, { endpoint: "https://push.example/x" }],
] as const;

describe("X-Room-Auth 必須エンドポイントの認証（FR-4.3）", () => {
  it("ヘッダ無しは 403（全 6 エンドポイント）", async () => {
    const { roomId } = await seedRoom();
    for (const [method, path, body] of ENDPOINTS(roomId)) {
      const r = await call(method, path, body ? { body } : {});
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body.error).toBe("unauthorized_room");
    }
  });

  it("ヘッダ形式が不正（空・短・大文字・非16進）でも 403（401/400 ではなく）", async () => {
    const { roomId, auth } = await seedRoom();
    const bad = [
      "",
      "   ",
      auth.slice(0, 63),
      auth + "0",
      auth.toUpperCase(),
      "g".repeat(64),
      "0".repeat(64),
      "Bearer " + auth.slice(7),
    ];
    for (const header of bad) {
      const r = await call("GET", `/api/rooms/${roomId}/messages`, { auth: header });
      expect(r.status, JSON.stringify(header.slice(0, 20))).toBe(403);
    }
  });

  it("正しい H(K_R‖PIN) なら参加できる（FR-2.2）", async () => {
    const { roomId, kr, pin } = await seedRoom();
    const auth = await roomAuthHash(kr, pin);
    const r = await call("POST", `/api/rooms/${roomId}/join`, { auth, body: {} });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("PIN が 1 桁違うだけで 403（セッション発行なし・毎回照合）", async () => {
    const { roomId, kr, pin } = await seedRoom();
    const wrong = await roomAuthHash(kr, pin === ALT_PIN ? "111111" : ALT_PIN);
    const ok = await call("POST", `/api/rooms/${roomId}/join`, { auth: await roomAuthHash(kr, pin), body: {} });
    expect(ok.status).toBe(200);
    const bad = await call("POST", `/api/rooms/${roomId}/join`, { auth: wrong, body: {} });
    expect(bad.status).toBe(403);
    expect(bad.body.error).toBe("unauthorized_room");
  });

  it("ルームID は存在するが鍵が違う → 404 ではなく 403（存在漏えいに配慮した設計）", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    const r = await call("GET", `/api/rooms/${b.roomId}/messages`, { auth: a.auth });
    expect(r.status).toBe(403);
  });

  it("ルームが存在しない（削除済み含む）UUID v4 は 404", async () => {
    const ghost = "9b2f8f3c-6e0a-4d3e-8f1c-2a5b7c9d0e1f";
    const auth = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", randomBytes(32))));
    for (const [method, path, body] of ENDPOINTS(ghost)) {
      const r = await call(method, path, { auth, ...(body ? { body } : {}) });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.body.error).toBe("not_found");
    }
  });

  it("A1・A2 は認証ヘッダ不要（設計 §5）", async () => {
    expect((await call("GET", "/api/vapid")).status).toBe(200);
    const r = await call("POST", "/api/rooms", { body: { keyHash: "b".repeat(64) } });
    expect(r.status).toBe(201);
  });

  it("key_hash は 32 バイト BLOB で、認証に使うヘッダは平文保存されない", async () => {
    const { roomId, kr, pin } = await seedRoom();
    const auth = await roomAuthHash(kr, pin);
    const row = await db.prepare("SELECT typeof(key_hash) AS t, length(key_hash) AS len, hex(key_hash) AS h FROM rooms WHERE id = ?1")
      .bind(roomId).first<{ t: string; len: number; h: string }>();
    expect(row!.t).toBe("blob");
    expect(row!.len).toBe(32);
    expect(row!.h.toLowerCase()).toBe(auth);
  });
});

describe("定数時間比較（設計 §11・FR-1.4）", () => {
  it("一致・不一致・長さ違い・不正16進の判定", () => {
    const hash = new Uint8Array(32).map((_, i) => i);
    const hex = bytesToHex(hash);
    expect(constantTimeEqualHex(hex, hash)).toBe(true);
    expect(constantTimeEqualHex(hex, hash.buffer as ArrayBuffer)).toBe(true);
    const off1 = hash.slice();
    off1[31] = off1[31]! ^ 0x01;
    expect(constantTimeEqualHex(hex, off1)).toBe(false);
    const offTop = hash.slice();
    offTop[0] = offTop[0]! ^ 0x80;
    expect(constantTimeEqualHex(hex, offTop)).toBe(false);
    expect(constantTimeEqualHex(hex, hash.slice(0, 31))).toBe(false);
    expect(constantTimeEqualHex(hex, new Uint8Array(33))).toBe(false);
    expect(constantTimeEqualHex("zz", hash)).toBe(false);
    expect(constantTimeEqualHex(hex.slice(1), hash)).toBe(false);
  });

  it("大文字16進のヘッダは比較前に弾かれる（DB との比較に至らない）", async () => {
    const { roomId, auth } = await seedRoom();
    expect(hexToBytes(auth.toUpperCase())).not.toBeNull(); // ヘキサ変換自体は受ける
    const r = await call("GET", `/api/rooms/${roomId}/messages`, { auth: auth.toUpperCase() });
    expect(r.status).toBe(403);
  });
});

describe("メッセージ送信の認証とドメイン境界", () => {
  it("他ルームのメッセージ一覧・画像データへアクセスできない", async () => {
    const a = await seedRoom({ roomId: UUID_A });
    const b = await seedRoom({ roomId: UUID_B });
    const imageCt = fakeCt(5000);
    const msgId = await insertMessage({
      roomId: b.roomId,
      kind: "image",
      ct: null,
      blobs: [imageCt],
    });
    await insertSub({ roomId: b.roomId });

    const list = await call("GET", `/api/rooms/${a.roomId}/messages`, { auth: a.auth });
    expect(list.status).toBe(200);
    expect(list.body.messages).toEqual([]);

    const data = await call("GET", `/api/rooms/${a.roomId}/messages/${msgId}/data`, { auth: a.auth });
    expect(data.status).toBe(404);
  });
});
