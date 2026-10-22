/** 通知許可とWebPush購読（FR-2.4 / FR-6.1 / 設計 §6.5・§8） */

import { api } from "./api.ts";
import { base64UrlToBytes } from "../shared/bytes.ts";
import type { RoomRecord } from "./idb.ts";

/** ユーザジェスチャ内で同期的に呼ぶこと（FR-2.4） */
export function requestPermissionWithinGesture(): void {
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}

export function notifySupported(): boolean {
  return (
    "Notification" in window && "PushManager" in window &&
    "serviceWorker" in navigator
  );
}

/** 購読済みならPUT（endpoint差分時のみ）。失敗してもチャットは継続（FR-6は付加的） */
export async function ensureSubscription(
  room: RoomRecord,
  authHash: string,
): Promise<void> {
  if (!notifySupported() || Notification.permission !== "granted") return;
  const { publicKey } = await api.getVapid();
  const appServerKey = base64UrlToBytes(publicKey);
  if (!appServerKey) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: appServerKey,
  });
  const json = sub.toJSON();
  if (!json.endpoint) return;
  const keys = json.keys as { p256dh?: string; auth?: string } | undefined;
  if (!keys?.p256dh || !keys?.auth) return;
  await api.subscribe(room.roomId, authHash, {
    endpoint: json.endpoint,
    p256dh: keys.p256dh,
    auth: keys.auth,
  });
  room.pushEndpoint = json.endpoint;
}
