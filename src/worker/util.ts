/** HTTP・検証・比較のユーティリティ（設計 §5 / §11） */

import { MAX_BODY_BYTES, HEX64_RE } from "../shared/constants.ts";
export { HEX64_RE, UUID_V4_RE } from "../shared/constants.ts";
import { hexToBytes, toBytes } from "../shared/bytes.ts";
import type { Env } from "./env.ts";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function isBase64(s: string): boolean {
  return s.length > 0 && s.length % 4 === 0 && B64_RE.test(s);
}

/** リクエストボディ読み出し（サイズ上限: 設計 §4.2） */
export async function readJsonBody<T>(req: Request): Promise<T> {
  const lenHeader = req.headers.get("content-length");
  if (lenHeader !== null && Number(lenHeader) > MAX_BODY_BYTES) {
    throw new ApiError("too_large", 413);
  }
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new ApiError("too_large", 413);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError("bad_request", 400);
  }
}

/** hex64 と BLOB の定数時間比較（FR-1.4 / 設計 §11） */
export function constantTimeEqualHex(
  hex: string,
  blob: ArrayBuffer | Uint8Array,
): boolean {
  const a = hexToBytes(hex);
  if (!a) return false;
  const b = toBytes(blob);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export type AuthResult = "ok" | "unauthorized" | "notfound";

/** X-Room-Auth ヘッダの照合（FR-4.3） */
export async function authenticate(
  env: Env,
  roomId: string,
  req: Request,
): Promise<AuthResult> {
  const header = req.headers.get("x-room-auth") ?? "";
  if (!HEX64_RE.test(header)) return "unauthorized";
  const row = await env.DB.prepare("SELECT key_hash FROM rooms WHERE id = ?1")
    .bind(roomId)
    .first<{ key_hash: ArrayBuffer }>();
  if (!row) return "notfound";
  return constantTimeEqualHex(header, row.key_hash)
    ? "ok"
    : "unauthorized";
}

export function authFailed(result: AuthResult): Response | null {
  if (result === "ok") return null;
  return result === "notfound"
    ? json({ error: "not_found" }, 404)
    : json({ error: "unauthorized_room" }, 403);
}
