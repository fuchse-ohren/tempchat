/**
 * Worker 統合テスト共通ヘルパ（設計 §10-2）
 * - D1 スキーマは migrations/0001_init.sql を適用する（設計 §4.1 との乖離を防ぐ）
 * - API は実際の fetch ハンドラを直接呼ぶ（ExecutionContext を渡せるため
 *   ctx.waitUntil(sendPush) の完了を待てる）
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import schemaSql from "../../migrations/0001_init.sql?raw";
import type { Env } from "../../src/worker/env.ts";
import worker from "../../src/worker/index.ts";
import {
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8,
} from "../../src/shared/bytes.ts";
import { roomAuthHash } from "../../src/shared/crypto.ts";
import { HEX64_RE, PAGE_LIMIT_MAX } from "../../src/shared/constants.ts";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const PIN = "123456";
export const ALT_PIN = "654321";
export const UUID_A = "11111111-1111-4111-8111-111111111111";
export const UUID_B = "22222222-2222-4222-8222-222222222222";
export {
  createExecutionContext,
  waitOnExecutionContext,
  roomAuthHash,
  bytesToHex,
  hexToBytes,
  randomBytes,
  utf8,
  HEX64_RE,
  PAGE_LIMIT_MAX,
};

export const testEnv = env as unknown as Env;
export const db = testEnv.DB;

/** migrations/0001_init.sql のステートメント列（行頭 -- コメントと空行を落とす） */
function migrationStatements(): string[] {
  const sql = schemaSql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
  return sql
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * スキーマ（migrations/0001_init.sql）を適用し、全テーブルを空にする。
 * Miniflare の D1 はプール内で共有されるため、毎テスト前にクリーンにする。
 */
export async function applySchema(): Promise<void> {
  const has = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'",
    )
    .first<{ name: string }>();
  if (!has) {
    await db.batch(migrationStatements().map((q) => db.prepare(q)));
  }
  await db.batch([
    db.prepare("DELETE FROM message_blobs"),
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM push_subs"),
    db.prepare("DELETE FROM rooms"),
  ]);
}

export interface SeededRoom {
  roomId: string;
  kr: Uint8Array;
  pin: string;
  auth: string;
}

/** rooms にテストルームを直接挿入する（K_R・PIN と H(K_R‖PIN) を対で保持） */
export async function seedRoom(opts: {
  roomId?: string;
  pin?: string;
  kr?: Uint8Array;
  createdAt?: number;
  lastMsgAt?: number | null;
} = {}): Promise<SeededRoom> {
  const roomId = opts.roomId ?? crypto.randomUUID();
  const kr = opts.kr ?? randomBytes(32);
  const pin = opts.pin ?? PIN;
  const auth = await roomAuthHash(kr, pin);
  await db
    .prepare(
      "INSERT INTO rooms (id, key_hash, created_at, last_msg_at) VALUES (?1, ?2, ?3, ?4)",
    )
    .bind(
      roomId,
      hexToBytes(auth),
      opts.createdAt ?? Date.now(),
      opts.lastMsgAt ?? null,
    )
    .run();
  return { roomId, kr, pin, auth };
}

/** 時刻などを直接制御してメッセージ行を作る（purge 境界テスト用） */
export async function insertMessage(row: {
  roomId: string;
  ts?: number;
  kind?: "text" | "image";
  ct?: Uint8Array | null;
  receivedAt?: number;
  blobs?: Uint8Array[];
}): Promise<number> {
  const res = await db
    .prepare(
      "INSERT INTO messages (room_id, ts, kind, ct, received_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(
      row.roomId,
      row.ts ?? Date.now(),
      row.kind ?? "text",
      row.ct ?? null,
      row.receivedAt ?? Date.now(),
    )
    .run();
  const id = Number(res.meta?.last_row_id ?? 0);
  if (row.blobs && row.blobs.length > 0) {
    await db.batch(
      row.blobs.map((chunk, seq) =>
        db
          .prepare("INSERT INTO message_blobs (msg_id, seq, chunk) VALUES (?1, ?2, ?3)")
          .bind(id, seq, chunk),
      ),
    );
  }
  return id;
}

/** push_subs に購読を直接挿入する */
export async function insertSub(opts: {
  roomId: string;
  endpoint?: string;
  p256dh?: string;
  auth?: string;
  createdAt?: number;
}): Promise<string> {
  const endpoint =
    opts.endpoint ?? `https://push.example/${crypto.randomUUID()}`;
  await db
    .prepare(
      "INSERT INTO push_subs (endpoint, room_id, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    )
    .bind(
      endpoint,
      opts.roomId,
      opts.p256dh ?? "BP-key",
      opts.auth ?? "auth-secret",
      opts.createdAt ?? Date.now(),
    )
    .run();
  return endpoint;
}

export interface CallResult {
  status: number;
  body: any;
  res: Response;
  ctx: ExecutionContext;
}

/** API を実際に呼ぶ。waitUntil の完了は settle(ctx) で待つ */
export async function call(
  method: string,
  path: string,
  opts: {
    auth?: string;
    body?: unknown;
    raw?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<CallResult> {
  const headers = new Headers(opts.headers);
  if (opts.auth !== undefined) headers.set("x-room-auth", opts.auth);
  let body: string | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers.set("content-type", "application/json");
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers.set("content-type", "application/json");
  }
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request(`http://tempchat.local${path}`, { method, headers, body }),
    testEnv,
    ctx,
  );
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, res, ctx };
}

/** ctx.waitUntil() された処理の完了を待つ */
export async function settle(ctx: ExecutionContext): Promise<void> {
  await waitOnExecutionContext(ctx);
}

/** ct を生成する（base64 前のバイト長を正確に制御） */
export function fakeCt(len: number, seed = 7): Uint8Array {
  const b = new Uint8Array(len);
  for (let i = 0; i < len; i++) b[i] = (i * 31 + seed * 17) & 0xff;
  return b;
}

/** テスト側で base64 を組む（Node 実装＝独立系） */
export function b64(b: Uint8Array): string {
  return Buffer.from(b).toString("base64");
}

export function fromB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

/** バイト列中に needle が含まれるか（平文混入監査用） */
export function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  const h = haystack;
  outer: for (let i = 0; i + needle.length <= h.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (h[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}
