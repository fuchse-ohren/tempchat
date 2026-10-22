/** Service Worker: push 受信・通知表示・タップ遷移（設計 §6.5・§8） */

/// <reference lib="webworker" />

import { base64ToBytes } from "../shared/bytes.ts";
import { decodeMessage } from "../shared/cbor.ts";
import { decryptMessage, deriveMessageKey } from "../shared/crypto.ts";
import { openDb } from "../client/idb.ts";
import type { PushPayload } from "../shared/types.ts";

const sw = self as unknown as ServiceWorkerGlobalScope;

sw.addEventListener("install", (e) => {
  e.waitUntil(sw.skipWaiting());
});
sw.addEventListener("activate", (e) => {
  e.waitUntil(sw.clients.claim());
});
sw.addEventListener("push", (e) => {
  e.waitUntil(onPush(e));
});
sw.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(onNotificationClick(e));
});

/** rooms ストアを直接引く（idb.ts のラッパはアプリ側のため最小実装） */
async function getRoom(roomId: string): Promise<{
  kr: Uint8Array;
  pin: string;
  sentIds: number[];
} | null> {
  const db = await openDb();
  return new Promise((resolve) => {
    const t = db.transaction("rooms", "readonly");
    const req = t.objectStore("rooms").get(roomId);
    req.onsuccess = () => {
      const r = req.result as
        | { kr: Uint8Array; pin: string; sentIds: number[] }
        | undefined;
      resolve(r ? { kr: r.kr, pin: r.pin, sentIds: r.sentIds ?? [] } : null);
    };
    req.onerror = () => resolve(null);
  });
}

async function onPush(e: PushEvent): Promise<void> {
  let p: PushPayload | null = null;
  try {
    const parsed = JSON.parse(e.data?.text() ?? "null") as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as PushPayload).v === 1 &&
      typeof (parsed as PushPayload).roomId === "string" &&
      typeof (parsed as PushPayload).id === "number" &&
      typeof (parsed as PushPayload).ts === "number" &&
      ((parsed as PushPayload).kind === "text" ||
        (parsed as PushPayload).kind === "image")
    ) {
      p = parsed as PushPayload;
    }
  } catch {
    /* 不正ペイロードは無視 */
  }
  if (!p) return;

  const room = await getRoom(p.roomId);
  if (!room) return; // このブラウザは参加していない/消去済み
  if (room.sentIds.includes(p.id)) return; // 自分の送信（設計 §6.5）

  let title = "tempchat";
  let body = "メッセージが届きました";
  if (p.kind === "image") {
    body = "📷 画像メッセージが届きました"; // FR-6.3
  } else if (typeof p.ct === "string") {
    const bytes = base64ToBytes(p.ct);
    if (bytes) {
      try {
        const key = await deriveMessageKey(room.kr, room.pin, p.ts);
        const wire = decodeMessage(await decryptMessage(key, p.ts, bytes));
        title = wire.name; // FR-6.2
        body = wire.kind === "text" ? wire.body : "📷 画像メッセージが届きました";
      } catch {
        /* 復号失敗は汎用通知のまま（設計 §6.5） */
      }
    }
  }

  await sw.registration.showNotification(title, {
    body,
    tag: `tempchat:${p.roomId}:${p.id}`,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { roomId: p.roomId },
  });
}

/** 通知タップ: 既存タブがあればフォーカス、なければ新規表示（FR-6.5） */
async function onNotificationClick(e: NotificationEvent): Promise<void> {
  const roomId =
    typeof e.notification.data?.roomId === "string"
      ? (e.notification.data.roomId as string)
      : null;
  const path = roomId ? `/${roomId}` : "/";
  const clientList = await sw.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const c of clientList) {
    if (c.url.includes(path) && "focus" in c) {
      await c.focus();
      return;
    }
  }
  await sw.clients.openWindow(path);
}
