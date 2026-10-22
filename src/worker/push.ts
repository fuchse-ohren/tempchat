/** Webプッシュ配信（設計 §6.5）。専用バインディングは無いため web-push + VAPID（§12） */

import { bytesToBase64 } from "../shared/bytes.ts";
import {
  PUSH_CT_INLINE_MAX,
  PUSH_PAYLOAD_MAX,
  PUSH_SUBS_PER_ROOM,
  PUSH_TTL_SECONDS,
} from "../shared/constants.ts";
import type { MessageKind, PushPayload } from "../shared/types.ts";
import { utf8 } from "../shared/bytes.ts";
import webpush from "web-push";
import type { Env } from "./env.ts";

interface SubRow {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function sendPush(
  env: Env,
  roomId: string,
  msg: { id: number; ts: number; kind: MessageKind },
  textCt?: Uint8Array,
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return; // 開発環境で鍵未設定なら通知なし（APIは正常）
  }
  const { results } = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subs WHERE room_id = ?1 LIMIT ?2`,
  )
    .bind(roomId, PUSH_SUBS_PER_ROOM)
    .all<SubRow>();
  if (!results || results.length === 0) return;

  webpush.setVapidDetails(
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );

  const payload: PushPayload = { v: 1, roomId, id: msg.id, ts: msg.ts, kind: msg.kind };
  let body = JSON.stringify(payload);
  if (msg.kind === "text" && textCt && textCt.length <= PUSH_CT_INLINE_MAX) {
    const withCt = JSON.stringify({ ...payload, ct: bytesToBase64(textCt) });
    if (utf8(withCt).length <= PUSH_PAYLOAD_MAX) body = withCt;
  }

  for (const s of results) {
    try {
      await webpush.sendNotification(
        {
          endpoint: s.endpoint,
          keys: { p256dh: s.p256dh, auth: s.auth },
        } as unknown as webpush.PushSubscription,
        body,
        { TTL: PUSH_TTL_SECONDS },
      );
    } catch (e: unknown) {
      const sc = (e as { statusCode?: number })?.statusCode;
      if (sc === 404 || sc === 410) {
        // FR-6.6 サブスクリプション除去
        await env.DB.prepare("DELETE FROM push_subs WHERE endpoint = ?1")
          .bind(s.endpoint)
          .run();
      }
      // その他（一時的障害）は何もしない。平文・鍵はログに出さない
    }
  }
}
