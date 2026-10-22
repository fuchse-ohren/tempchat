/**
 * 受け入れ基準3「サーバD1を直接確認し、メッセージ平文・表示名・PIN平文・K_R が
 * 格納されていないことを確認する」の自動監査（設計 §10-2「DBに平文が混入しないこと」）
 *
 * 実クライアントと同じ共有モジュール（cbor.ts / crypto.ts）でメッセージを作り、
 * A2/A4 経由で送信した後、D1 の全テーブル全カラムを走査して
 * 平文・表示名・PIN・K_R の混入を検出する。
 */
import { encode } from "cbor2";
import { beforeEach, describe, expect, it } from "vitest";
import {
  applySchema,
  b64,
  bytesToHex,
  call,
  containsBytes,
  db,
  randomBytes,
  roomAuthHash,
  seedRoom,
  settle,
  utf8,
} from "./helpers.ts";
import { encodeMessage } from "../../src/shared/cbor.ts";
import { deriveMessageKey, encryptMessage } from "../../src/shared/crypto.ts";
import type { WireMessage } from "../../src/shared/types.ts";

/** 監査に使う秘密値（DB に現れてはならない） */
const SECRET = {
  pin: "824913",
  name: "さくら花子-secretname",
  body: "ひみつの内容-PLAINTEXT-MARKER-1234567890",
  fileName: "secret-photo.webp",
  imagePayload: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpTZ3duZGxvd21hcmtlcg==",
};

beforeEach(async () => {
  await applySchema();
});

/** D1 の全テーブルを走査し、混入が許されないバイト列を検出する */
async function scanDatabase(needles: Map<string, Uint8Array>): Promise<string[]> {
  const violations: string[] = [];
  const tables: [string, string[]][] = [
    ["rooms", ["id", "key_hash", "created_at", "last_msg_at"]],
    ["messages", ["id", "room_id", "ts", "kind", "ct", "received_at"]],
    ["message_blobs", ["msg_id", "seq", "chunk"]],
    ["push_subs", ["endpoint", "room_id", "p256dh", "auth", "created_at"]],
  ];
  for (const [table, cols] of tables) {
    const { results } = await db
      .prepare(`SELECT ${cols.join(", ")} FROM ${table}`)
      .all<Record<string, unknown>>();
    for (const row of results ?? []) {
      for (const col of cols) {
        const value = row[col];
        if (value === null || value === undefined) continue;
        const bytes =
          value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : value instanceof Uint8Array
              ? value
              : utf8(String(value));
        for (const [label, needle] of needles) {
          if (needle.length > 0 && containsBytes(bytes, needle)) {
            violations.push(`${table}.${col} = ${label}`);
          }
        }
      }
    }
  }
  return violations;
}

async function postText(roomId: string, auth: string, kr: Uint8Array, pin: string, ts: number, body: string, name: string) {
  const wire: WireMessage = {
    v: 1,
    id: crypto.randomUUID(),
    kind: "text",
    name,
    ts,
    body,
  };
  const key = await deriveMessageKey(kr, pin, ts);
  const ct = await encryptMessage(key, ts, encodeMessage(wire));
  return call("POST", `/api/rooms/${roomId}/messages`, {
    auth,
    body: { ts, kind: "text", ct: b64(ct) },
  });
}

describe("受け入れ基準3: D1 に平文・鍵・PIN が混入しない", () => {
  it("テキスト送信後の DB 全走査で平文・表示名・PIN・K_R を検出しない", async () => {
    const kr = randomBytes(32);
    const ts = Date.now();

    // ルーム作成は A2 経由（クライアントと同じ H(K_R‖PIN) のみを送る）
    const auth = await roomAuthHash(kr, SECRET.pin);
    const created = await call("POST", "/api/rooms", { body: { keyHash: auth } });
    expect(created.status).toBe(201);
    const roomId = created.body.roomId as string;
    const joined = await call("POST", `/api/rooms/${roomId}/join`, { auth, body: {} });
    expect(joined.status).toBe(200);

    const sent = await postText(roomId, auth, kr, SECRET.pin, ts, SECRET.body, SECRET.name);
    expect(sent.status).toBe(201);
    // 画像も送信して blob 側も検査する
    const imageWire: WireMessage = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "image",
      name: SECRET.name,
      ts: ts + 1,
      body: { d: SECRET.imagePayload, m: "image/webp", n: SECRET.fileName },
    };
    const imageKey = await deriveMessageKey(kr, SECRET.pin, ts + 1);
    const imageCt = await encryptMessage(imageKey, ts + 1, encodeMessage(imageWire));
    const sentImage = await call("POST", `/api/rooms/${roomId}/messages`, {
      auth,
      body: { ts: ts + 1, kind: "image", ct: b64(imageCt) },
    });
    expect(sentImage.status).toBe(201);
    await settle(sent.ctx);
    await settle(sentImage.ctx);

    const needles = new Map<string, Uint8Array>([
      ["平文本文(utf8)", utf8(SECRET.body)],
      ["表示名(utf8)", utf8(SECRET.name)],
      ["画像ファイル名(utf8)", utf8(SECRET.fileName)],
      ["画像base64(utf8)", utf8(SECRET.imagePayload)],
      ["CBORのキー名(kind)", utf8("kind")],
      ["PIN(ascii)", utf8(SECRET.pin)],
      ["K_R(raw 32B)", kr],
      ["K_R(hex64)", utf8(bytesToHex(kr))],
      ["K_R(base64)", utf8(Buffer.from(kr).toString("base64"))],
      ["K_R(base64url)", utf8(Buffer.from(kr).toString("base64url"))],
    ]);
    const violations = await scanDatabase(needles);
    expect(violations).toEqual([]);

    // 対照実験: 同じ走査ロジックで「保存されているべき値」は必ず検出できること
    const positive = await scanDatabase(
      new Map([["room_id", utf8(roomId)], ["kind text", utf8("text")], ["kind image", utf8("image")]]),
    );
    expect(positive.length).toBeGreaterThan(0);
  });

  it("CT の中に CBOR フィールド名・平文がそのまま含まれていない（暗号化の実効性）", async () => {
    const kr = randomBytes(32);
    const { roomId, auth } = await seedRoom({ kr, pin: SECRET.pin });
    const ts = Date.now();
    await postText(roomId, auth, kr, SECRET.pin, ts, SECRET.body, SECRET.name);

    const { results } = await db
      .prepare("SELECT ct FROM messages WHERE kind = 'text'")
      .all<{ ct: ArrayBuffer }>();
    expect(results.length).toBe(1);
    const ct = new Uint8Array(results[0]!.ct);
    // 復号に使う材料（PIN・鍵・平文）が暗号文から出ない
    for (const needle of [utf8(SECRET.body), utf8(SECRET.name), utf8(SECRET.pin), kr]) {
      expect(containsBytes(ct, needle)).toBe(false);
    }
    // CBOR の平文表現（"name" / "body" キー）も漏れない
    const cborPlaintext = encode({ name: SECRET.name, body: SECRET.body });
    expect(containsBytes(ct, new Uint8Array(cborPlaintext))).toBe(false);
    // 暗号文は IV(12B)+GCM であり、平文長とは一致しない（＝そのまま入っていない）
    expect(ct.length).toBeGreaterThanOrEqual(12 + 16);
  });

  it("ルーム作成リクエストの keyHash は H(K_R‖PIN) であり、K_R でも PIN でもない", async () => {
    const kr = randomBytes(32);
    const pin = SECRET.pin;
    const keyHash = await roomAuthHash(kr, pin);
    const created = await call("POST", "/api/rooms", { body: { keyHash } });
    expect(created.status).toBe(201);

    const violations = await scanDatabase(
      new Map([
        ["K_R(raw)", kr],
        ["K_R(hex)", utf8(bytesToHex(kr))],
        ["PIN", utf8(pin)],
        ["keyHash そのもの", utf8(keyHash)], // BLOB で持つので文字列としては存在しない
      ]),
    );
    expect(violations).toEqual([]);
    const row = await db.prepare("SELECT length(key_hash) AS len, hex(key_hash) AS h FROM rooms WHERE id = ?1")
      .bind(created.body.roomId).first<{ len: number; h: string }>();
    expect(row!.len).toBe(32);
    expect(row!.h.toLowerCase()).toBe(keyHash);
  });

  it("push_subs は購読情報だけを持ち、鍵・PIN・平文は持たない（FR-6.1）", async () => {
    const { roomId, auth } = await seedRoom({ pin: SECRET.pin });
    const ep = "https://push.example.com/endpoint/secret-endpoint-marker";
    const put = await call("PUT", `/api/rooms/${roomId}/subscription`, {
      auth,
      body: { endpoint: ep, p256dh: "BPNoBMG9dummyP256dh", auth: "dW5pcXVlLWF1dGg=" },
    });
    expect(put.status).toBe(204);
    const row = await db.prepare("SELECT endpoint, p256dh, auth, room_id FROM push_subs").first<Record<string, string>>();
    expect(row).not.toBeNull();
    expect(row!.endpoint).toBe(ep); // 設計上、購読 URL は平文メタデータ（SEC-2）

    const violations = await scanDatabase(
      new Map([
        ["PIN", utf8(SECRET.pin)],
        ["表示名", utf8(SECRET.name)],
        ["平文", utf8(SECRET.body)],
        ["K_R(hex)", utf8("f".repeat(64))],
      ]),
    );
    expect(violations).toEqual([]);
  });

  it("API レスポンス・エラー本文に内部情報が現れない（NFR-8 の簡易確認）", async () => {
    const { roomId, auth, kr, pin } = await seedRoom();
    const ok = await call("GET", `/api/rooms/${roomId}/messages`, { auth });
    const text = JSON.stringify(ok.body);
    expect(text).not.toContain(bytesToHex(kr));
    expect(text).not.toContain(pin);
    expect(text).not.toContain("[SQLITE");

    const err = await call("GET", `/api/rooms/${roomId}/messages`, { auth: "0".repeat(64) });
    expect(JSON.stringify(err.body)).toBe('{"error":"unauthorized_room"}');
    expect(err.res.headers.get("cache-control")).toBe("no-store");
  });
});
