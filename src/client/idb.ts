/** IndexedDB 永続化層（設計 §4.3。DOM非依存 → SWからも利用可） */

import { IDB_NAME, IDB_VERSION, SENT_IDS_MAX } from "../shared/constants.ts";
import type { MessageKind } from "../shared/types.ts";

export interface RoomRecord {
  roomId: string;
  kr: Uint8Array;
  pin: string;
  name: string;
  createdAt: number;
  lastId: number;
  sentIds: number[];
  pushEndpoint?: string;
}

export interface StoredMessage {
  roomId: string;
  /** 送信時は負の一時ID、サーバ応答で実IDへ置換。画像は bytes 未取得の場合 undefined */
  rowid: number;
  ts: number;
  kind: MessageKind;
  name: string;
  text?: string;
  image?: { mime: string; bytes?: ArrayBuffer; fileName: string };
  receivedAt: number;
  pending?: boolean;
  /** 送信失敗した pending（設計 §6.3「送信失敗」表示。再読込時は pending として掃除） */
  failed?: boolean;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("rooms")) {
          db.createObjectStore("rooms", { keyPath: "roomId" });
        }
        if (!db.objectStoreNames.contains("messages")) {
          const st = db.createObjectStore("messages", {
            keyPath: ["roomId", "rowid"],
          });
          st.createIndex("by_room", "roomId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function roomGet(roomId: string): Promise<RoomRecord | undefined> {
  return (await tx<RoomRecord | undefined>("rooms", "readonly", (s) =>
    s.get(roomId),
  )) ?? undefined;
}

export function roomPut(rec: RoomRecord): Promise<unknown> {
  return tx("rooms", "readwrite", (s) => s.put(rec));
}

/** 送信メッセージの行IDを控える（FR-3.6・直近 SENT_IDS_MAX 件） */
export async function roomAddSentId(roomId: string, id: number): Promise<void> {
  const rec = await roomGet(roomId);
  if (!rec) return;
  const sentIds = [...rec.sentIds, id];
  rec.sentIds = sentIds.slice(-SENT_IDS_MAX);
  await roomPut(rec);
}

export function msgPut(rec: StoredMessage): Promise<unknown> {
  return tx("messages", "readwrite", (s) => s.put(rec));
}

export function msgDelete(roomId: string, rowid: number): Promise<unknown> {
  return tx("messages", "readwrite", (s) => s.delete([roomId, rowid]));
}

export async function msgsList(roomId: string): Promise<StoredMessage[]> {
  const all = await tx<StoredMessage[]>("messages", "readonly", (s) =>
    s.index("by_room").getAll(IDBKeyRange.only(roomId)),
  );
  // 表示順: クライアントts昇順、同一tsは受信行ID昇順（FR-3.5 / 設計 §6.4）
  return all.sort((a, b) => a.ts - b.ts || a.rowid - b.rowid);
}

/** ロード時に未達 pending（負rowid）を掃除する */
export async function msgsCleanPending(roomId: string): Promise<void> {
  const all = await msgsList(roomId);
  for (const m of all) {
    if (m.pending) await msgDelete(roomId, m.rowid);
  }
}
