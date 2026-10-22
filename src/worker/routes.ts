/** API ルーティング（設計 §5 A1〜A8） */

import {
  base64ToBytes,
  bytesToBase64,
  concatBytes,
  hexToBytes,
  toBytes,
} from "../shared/bytes.ts";
import {
  CHUNK_MAX_COUNT,
  CHUNK_SIZE,
  CT_MAX_IMAGE,
  CT_MAX_TEXT,
  PAGE_LIMIT_MAX,
  PUSH_SUBS_PER_ROOM,
  TS_FUTURE_SKEW_MS,
  TS_MIN,
} from "../shared/constants.ts";
import type {
  CreateRoomRequest,
  PostMessageRequest,
  SubscribeRequest,
} from "../shared/types.ts";
import type { Env } from "./env.ts";
import { sendPush } from "./push.ts";
import {
  ApiError,
  authFailed,
  authenticate,
  HEX64_RE,
  isBase64,
  json,
  noContent,
  readJsonBody,
  UUID_V4_RE,
} from "./util.ts";

export async function handleApi(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  const p = url.pathname;
  const m = req.method;

  // A1: VAPID公開鍵
  if (p === "/api/vapid" && m === "GET") {
    if (!env.VAPID_PUBLIC_KEY) throw new ApiError("internal", 500);
    return json({ publicKey: env.VAPID_PUBLIC_KEY });
  }

  // A2: ルーム作成
  if (p === "/api/rooms" && m === "POST") {
    const body = await readJsonBody<CreateRoomRequest>(req);
    if (typeof body.keyHash !== "string" || !HEX64_RE.test(body.keyHash)) {
      throw new ApiError("bad_request", 400);
    }
    const roomId = crypto.randomUUID();
    const hashBytes = hexToBytes(body.keyHash);
    if (!hashBytes) throw new ApiError("bad_request", 400);
    await env.DB.prepare(
      "INSERT INTO rooms (id, key_hash, created_at) VALUES (?1, ?2, ?3)",
    )
      .bind(roomId, hashBytes, Date.now())
      .run();
    return json({ roomId }, 201);
  }

  const roomMatch = p.match(/^\/api\/rooms\/([^/]+)(?:\/(.*))?$/);
  if (roomMatch) {
    const roomId = roomMatch[1] ?? "";
    const rest = roomMatch[2] ?? "";
    if (!UUID_V4_RE.test(roomId)) return json({ error: "not_found" }, 404);

    // A3: 参加（PIN照合）
    if (rest === "join" && m === "POST") {
      const fail = authFailed(await authenticate(env, roomId, req));
      if (fail) return fail;
      return json({ ok: true });
    }

    // A4/A5: メッセージ送受信
    if (rest === "messages") {
      const fail = authFailed(await authenticate(env, roomId, req));
      if (fail) return fail;
      if (m === "POST") return postMessage(env, ctx, roomId, req);
      if (m === "GET") return listMessages(env, roomId, url);
      throw new ApiError("bad_request", 400);
    }

    // A6: 画像暗号文取得
    const dataMatch = rest.match(/^messages\/(\d+)\/data$/);
    if (dataMatch && m === "GET") {
      const fail = authFailed(await authenticate(env, roomId, req));
      if (fail) return fail;
      return messageData(env, roomId, Number(dataMatch[1]));
    }

    // A7/A8: プッシュ購読
    if (rest === "subscription") {
      const fail = authFailed(await authenticate(env, roomId, req));
      if (fail) return fail;
      if (m === "PUT") return subscribe(env, roomId, req);
      if (m === "DELETE") return unsubscribe(env, roomId, req);
      throw new ApiError("bad_request", 400);
    }
  }

  return json({ error: "not_found" }, 404);
}

/** A4: メッセージ送信（設計 §6.4 / §4.2。画像はチャンク分割） */
async function postMessage(
  env: Env,
  ctx: ExecutionContext,
  roomId: string,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody<PostMessageRequest>(req);
  const now = Date.now();
  if (
    typeof body.ts !== "number" ||
    !Number.isInteger(body.ts) ||
    body.ts < TS_MIN ||
    body.ts > now + TS_FUTURE_SKEW_MS
  ) {
    throw new ApiError("bad_request", 400);
  }
  if (body.kind !== "text" && body.kind !== "image") {
    throw new ApiError("bad_request", 400);
  }
  if (typeof body.ct !== "string" || !isBase64(body.ct)) {
    throw new ApiError("bad_request", 400);
  }
  const ct = base64ToBytes(body.ct);
  if (!ct || ct.length === 0) throw new ApiError("bad_request", 400);
  const maxCt = body.kind === "text" ? CT_MAX_TEXT : CT_MAX_IMAGE;
  if (ct.length > maxCt) throw new ApiError("too_large", 413);
  const chunkCount = Math.ceil(ct.length / CHUNK_SIZE);
  if (chunkCount > CHUNK_MAX_COUNT) throw new ApiError("too_large", 413);

  // 1) メッセージ行を確定（行ID = FR-3.6 の二重表示排除キー）
  const insert = await env.DB.prepare(
    body.kind === "text"
      ? "INSERT INTO messages (room_id, ts, kind, ct, received_at) VALUES (?1, ?2, ?3, ?4, ?5)"
      : "INSERT INTO messages (room_id, ts, kind, ct, received_at) VALUES (?1, ?2, ?3, NULL, ?5)",
  )
    .bind(roomId, body.ts, body.kind, ct, now)
    .run();
  const rowId = Number(insert.meta?.last_row_id ?? 0);
  if (rowId === 0) throw new ApiError("internal", 500);

  // 2) ルーム最終更新（無操作30日判定はサーバ受信時刻基準）
  await env.DB.prepare("UPDATE rooms SET last_msg_at = ?1 WHERE id = ?2")
    .bind(now, roomId)
    .run();

  // 3) 画像チャンク（各ステートメントは b64 化しても 100KB を下回る）
  if (body.kind === "image") {
    const chunkStmts: D1PreparedStatement[] = [];
    for (let seq = 0, off = 0; off < ct.length; seq++, off += CHUNK_SIZE) {
      chunkStmts.push(
        env.DB.prepare(
          "INSERT INTO message_blobs (msg_id, seq, chunk) VALUES (?1, ?2, ?3)",
        ).bind(rowId, seq, ct.slice(off, off + CHUNK_SIZE)),
      );
    }
    await env.DB.batch(chunkStmts);
  }

  ctx.waitUntil(
    sendPush(
      env,
      roomId,
      { id: rowId, ts: body.ts, kind: body.kind },
      body.kind === "text" ? ct : undefined,
    ).catch(() => {}),
  );
  return json({ id: rowId }, 201);
}

/** A5: メッセージ差分取得（text のみ ct インライン。設計 §5） */
async function listMessages(
  env: Env,
  roomId: string,
  url: URL,
): Promise<Response> {
  const after = Number(url.searchParams.get("after") ?? "0");
  const limit = Math.min(
    Number(url.searchParams.get("limit") ?? String(PAGE_LIMIT_MAX)),
    PAGE_LIMIT_MAX,
  );
  if (
    !Number.isInteger(after) ||
    after < 0 ||
    !Number.isInteger(limit) ||
    limit < 1
  ) {
    throw new ApiError("bad_request", 400);
  }
  const { results } = await env.DB.prepare(
    "SELECT id, ts, kind, ct FROM messages WHERE room_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3",
  )
    .bind(roomId, after, limit)
    .all<{
      id: number;
      ts: number;
      kind: "text" | "image";
      ct: ArrayBuffer | null;
    }>();
  const messages = (results ?? []).map((r) => ({
    id: r.id,
    ts: r.ts,
    kind: r.kind,
    ...(r.ct !== null ? { ct: bytesToBase64(toBytes(r.ct)) } : {}),
  }));
  return json({ messages });
}

/** A6: 画像暗号文（チャンク結合） */
async function messageData(
  env: Env,
  roomId: string,
  mid: number,
): Promise<Response> {
  if (!Number.isInteger(mid) || mid <= 0) throw new ApiError("bad_request", 400);
  const msg = await env.DB.prepare(
    "SELECT kind FROM messages WHERE id = ?1 AND room_id = ?2",
  )
    .bind(mid, roomId)
    .first<{ kind: string }>();
  if (!msg || msg.kind !== "image") return json({ error: "not_found" }, 404);
  const { results } = await env.DB.prepare(
    "SELECT chunk FROM message_blobs WHERE msg_id = ?1 ORDER BY seq ASC",
  )
    .bind(mid)
    .all<{ chunk: ArrayBuffer }>();
  if (!results || results.length === 0) return json({ error: "not_found" }, 404);
  return json({ ct: bytesToBase64(concatBytes(results.map((r) => toBytes(r.chunk)))) });
}

/** A7: プッシュ購読 upsert（20件超過で最古削除） */
async function subscribe(
  env: Env,
  roomId: string,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody<SubscribeRequest>(req);
  if (
    typeof body.endpoint !== "string" ||
    body.endpoint.length === 0 ||
    body.endpoint.length > 1500 ||
    typeof body.p256dh !== "string" ||
    body.p256dh.length === 0 ||
    body.p256dh.length > 200 ||
    typeof body.auth !== "string" ||
    body.auth.length === 0 ||
    body.auth.length > 200
  ) {
    throw new ApiError("bad_request", 400);
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO push_subs (endpoint, room_id, p256dh, auth, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(endpoint) DO UPDATE SET
         room_id = excluded.room_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         created_at = excluded.created_at`,
    ).bind(body.endpoint, roomId, body.p256dh, body.auth, Date.now()),
    env.DB.prepare(
      `DELETE FROM push_subs WHERE room_id = ?1 AND endpoint NOT IN (
         SELECT endpoint FROM push_subs WHERE room_id = ?1
         ORDER BY created_at DESC LIMIT ?2)`,
    ).bind(roomId, PUSH_SUBS_PER_ROOM),
  ]);
  return noContent();
}

/** A8: プッシュ購読削除 */
async function unsubscribe(
  env: Env,
  roomId: string,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody<{ endpoint?: unknown }>(req);
  if (typeof body.endpoint !== "string" || body.endpoint.length === 0) {
    throw new ApiError("bad_request", 400);
  }
  await env.DB.prepare(
    "DELETE FROM push_subs WHERE room_id = ?1 AND endpoint = ?2",
  )
    .bind(roomId, body.endpoint)
    .run();
  return noContent();
}
