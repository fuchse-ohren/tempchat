/** Cron による期限切れ削除（FR-8 / 設計 §9） */

import { MSG_TTL_DAYS, ROOM_TTL_DAYS } from "../shared/constants.ts";
import type { Env } from "./env.ts";

const DAY_MS = 86_400_000;

export async function purgeExpired(env: Env, now = Date.now()): Promise<void> {
  const t7 = now - MSG_TTL_DAYS * DAY_MS;
  const t30 = now - ROOM_TTL_DAYS * DAY_MS;
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM message_blobs WHERE msg_id IN (SELECT id FROM messages WHERE received_at < ?1)",
    ).bind(t7),
    env.DB.prepare("DELETE FROM messages WHERE received_at < ?1").bind(t7),
    env.DB.prepare(
      `DELETE FROM message_blobs WHERE msg_id IN (
         SELECT m.id FROM messages m JOIN rooms r ON r.id = m.room_id
         WHERE COALESCE(r.last_msg_at, r.created_at) < ?1)`,
    ).bind(t30),
    env.DB.prepare(
      `DELETE FROM messages WHERE room_id IN (
         SELECT id FROM rooms WHERE COALESCE(last_msg_at, created_at) < ?1)`,
    ).bind(t30),
    env.DB.prepare(
      `DELETE FROM push_subs WHERE room_id IN (
         SELECT id FROM rooms WHERE COALESCE(last_msg_at, created_at) < ?1)`,
    ).bind(t30),
    env.DB.prepare(
      "DELETE FROM rooms WHERE COALESCE(last_msg_at, created_at) < ?1",
    ).bind(t30),
  ]);
}
