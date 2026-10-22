/** チャット画面（FR-3〜FR-7 の実装中核 / 設計 §6.4・§7.2） */

import { base64ToBytes, bytesToBase64 } from "../../shared/bytes.ts";
import {
  decodeMessage,
  encodeMessage,
  isName,
  isText,
} from "../../shared/cbor.ts";
import {
  decryptMessage,
  deriveMessageKey,
  encryptMessage,
  roomAuthHash,
} from "../../shared/crypto.ts";
import {
  IMAGE_MAX_BYTES,
  PAGE_LIMIT_MAX,
  PROTOCOL_VERSION,
  TEXT_MAX,
} from "../../shared/constants.ts";
import type { MessageDto, WireMessage } from "../../shared/types.ts";
import { api, ApiError } from "../api.ts";
import { bytesToObjectUrl, compressImage } from "../image.ts";
import {
  msgDelete,
  msgPut,
  msgsCleanPending,
  msgsList,
  roomAddSentId,
  roomGet,
  roomPut,
  type RoomRecord,
  type StoredMessage,
} from "../idb.ts";
import {
  ensureSubscription,
  notifySupported,
  requestPermissionWithinGesture,
} from "../notify.ts";
import { startPolling, type Poller } from "../polling.ts";
import {
  applyTheme,
  getThemeMode,
  setThemeMode,
  type ThemeMode,
} from "../theme.ts";
import { clear, h } from "../ui.ts";

/** Uint8Array → ArrayBuffer（境界コピー。IDB保存・Blob用） */
function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}

export async function renderChat(
  app: HTMLElement,
  roomId: string,
  onRoute: () => void,
): Promise<void> {
  const roomRec = await roomGet(roomId);
  if (!roomRec) {
    onRoute();
    return;
  }
  const room: RoomRecord = roomRec;
  const auth = await roomAuthHash(room.kr, room.pin);
  await msgsCleanPending(roomId);

  const messages = new Map<number, StoredMessage>();
  for (const m of await msgsList(roomId)) messages.set(m.rowid, m);

  const urlCache = new Map<number, string>();
  const imageLoading = new Set<number>();
  let poller: Poller | null = null;
  let fatal = false;

  // ---------- DOM 組み立て ----------
  const listEl = h("ol", { class: "messages", id: "msg-list" });
  const banner = h("div", { class: "banner", hidden: true });
  const panel = h("div", { class: "panel", hidden: true });
  const overlay = h("div", { class: "overlay", hidden: true });

  const closePanel = () => {
    panel.hidden = true;
    overlay.hidden = true;
  };
  const openPanel = (node: HTMLElement, title: string) => {
    clear(panel);
    panel.append(
      h(
        "div",
        { class: "panel-head" },
        h("strong", {}, title),
        h("button", {
          class: "btn btn-ghost",
          type: "button",
          on: { click: closePanel },
        }, "閉じる"),
      ),
      node,
    );
    panel.hidden = false;
    overlay.hidden = false;
  };
  overlay.addEventListener("click", closePanel);

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      prompt("コピーしてください", text);
    }
  }

  // ---------- 招待パネル（設計 §7.1） ----------
  const inviteLink = location.href;
  const invitePanel = h(
    "div",
    { class: "panel-body" },
    h("p", { class: "sub" }, "招待リンク（ルーム鍵を含みます。信頼できる相手にのみ共有してください）"),
    h("p", { class: "code" }, inviteLink),
    h("button", {
      class: "btn",
      type: "button",
      on: { click: () => void copyText(inviteLink) },
    }, "リンクをコピー"),
    h("p", { class: "sub" }, "PIN（リンクとは別の経路で共有）"),
    h("p", { class: "code" }, room.pin),
    h("button", {
      class: "btn",
      type: "button",
      on: { click: () => void copyText(room.pin) },
    }, "PINをコピー"),
  );

  // ---------- 設定パネル ----------
  const themeSelect = h(
    "select",
    { class: "input", id: "set-theme" },
    h("option", { value: "auto" }, "自動（端末設定）"),
    h("option", { value: "light" }, "ライト"),
    h("option", { value: "dark" }, "ダーク"),
  );
  themeSelect.value = getThemeMode();
  themeSelect.addEventListener("change", () => {
    setThemeMode(themeSelect.value as ThemeMode);
    applyTheme();
  });
  const nameInput = h("input", {
    class: "input",
    type: "text",
    maxlength: "20",
    value: room.name,
    id: "set-name",
  });
  const saveName = h("button", {
    class: "btn",
    type: "button",
    on: {
      click: () => {
        const v = nameInput.value.trim();
        if (!isName(v)) return;
        room.name = v;
        void roomPut(room);
        closePanel();
      },
    },
  }, "表示名を保存");
  const notifyBtn = h("button", {
    class: "btn",
    type: "button",
    on: {
      click: () => {
        requestPermissionWithinGesture();
        void ensureSubscription(room, auth).then(
          () => roomPut(room),
          () => {},
        );
      },
    },
  }, "ブラウザ通知を有効化する");
  const settingsPanel = h(
    "div",
    { class: "panel-body" },
    h("label", { class: "field" }, "テーマ", themeSelect),
    h("label", {
      class: "field",
    }, "表示名", h("div", { class: "row" }, nameInput, saveName)),
    h(
      "div",
      { class: "field" },
      notifySupported()
        ? notifyBtn
        : h("p", { class: "sub" }, "この端末では通知を利用できません"),
    ),
  );

  // ---------- 送信欄 ----------
  const textarea = h("textarea", {
    class: "composer-input",
    id: "composer-text",
    placeholder: `メッセージ（${TEXT_MAX}文字まで）`,
    maxlength: String(TEXT_MAX),
  });
  const counter = h("span", { class: "counter" }, `0/${TEXT_MAX}`);
  textarea.addEventListener("input", () => {
    counter.textContent = `${[...textarea.value].length}/${TEXT_MAX}`;
  });
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendText();
    }
  });
  const fileInput = h("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/webp",
    class: "hidden-file",
    id: "composer-file",
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files?.[0];
    fileInput.value = "";
    if (f) void sendImage(f);
  });
  const sendNote = h("p", { class: "err", hidden: true });

  const header = h(
    "header",
    { class: "app-header" },
    h("span", { class: "brand" }, "tempchat"),
    h(
      "div",
      { class: "header-actions" },
      h("button", {
        class: "btn btn-ghost",
        type: "button",
        id: "btn-invite",
        on: { click: () => openPanel(invitePanel, "招待") },
      }, "招待"),
      h("button", {
        class: "btn btn-ghost",
        type: "button",
        id: "btn-settings",
        on: { click: () => openPanel(settingsPanel, "設定") },
      }, "設定"),
    ),
  );
  const composer = h(
    "footer",
    { class: "composer" },
    h("div", { class: "composer-row" }, textarea),
    h(
      "div",
      { class: "composer-row composer-actions" },
      counter,
      h("label", { class: "btn", for: "composer-file" }, "画像"),
      h("button", {
        class: "btn btn-primary",
        type: "button",
        id: "btn-send",
        on: { click: () => void sendText() },
      }, "送信"),
    ),
    sendNote,
  );

  clear(app);
  app.append(
    h("div", { class: "chat-screen" }, header, banner, listEl, composer, overlay, panel, fileInput),
  );

  // ---------- 描画 ----------
  function render(): void {
    const items = [...messages.values()].sort(
      (a, b) => a.ts - b.ts || a.rowid - b.rowid,
    );
    const frag = document.createDocumentFragment();
    for (const m of items) frag.append(renderItem(m));
    listEl.replaceChildren(frag);
    listEl.scrollTop = listEl.scrollHeight;
    for (const m of items) {
      if (m.kind === "image" && !m.image?.bytes) void loadImage(m.rowid);
    }
  }

  function renderItem(m: StoredMessage): HTMLElement {
    const time = new Date(m.ts).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    const head = h(
      "div",
      { class: "msg-head" },
      h("strong", { class: "msg-name" }, m.name),
      h("span", { class: "msg-time" }, time),
      m.pending ? h("span", { class: "msg-flag" }, "送信中…") : null,
    );
    let bodyEl: HTMLElement;
    if (m.kind === "text") {
      bodyEl = h("p", { class: "msg-text" }, m.text ?? "");
    } else if (m.image?.bytes) {
      const img = h("img", { class: "msg-image", alt: m.image.fileName });
      let url = urlCache.get(m.rowid);
      if (!url) {
        url = bytesToObjectUrl(m.image.bytes, m.image.mime);
        urlCache.set(m.rowid, url);
      }
      img.src = url;
      bodyEl = h(
        "div",
        { class: "msg-body" },
        img,
        h("p", { class: "msg-file" }, m.image.fileName),
      );
    } else {
      bodyEl = h("p", { class: "msg-text sub" }, "画像を読み込み中…");
    }
    return h("li", { class: m.rowid < 0 ? "msg pending" : "msg" }, head, bodyEl);
  }

  // ---------- 復号 ----------
  async function decodeBlob(
    ts: number,
    blob: Uint8Array,
  ): Promise<WireMessage | null> {
    try {
      const key = await deriveMessageKey(room.kr, room.pin, ts);
      const plain = await decryptMessage(key, ts, blob);
      return decodeMessage(plain);
    } catch {
      return null; // 復号・スキーマ検証失敗は表示も保存もしない（FR-4.2）
    }
  }

  function wireToRecord(rowid: number, wire: WireMessage): StoredMessage {
    const rec: StoredMessage = {
      roomId,
      rowid,
      ts: wire.ts,
      kind: wire.kind,
      name: wire.name,
      receivedAt: Date.now(),
    };
    if (wire.kind === "text") {
      rec.text = wire.body;
    } else {
      const bytes = base64ToBytes(wire.body.d);
      rec.image = {
        mime: wire.body.m,
        fileName: wire.body.n,
        bytes: bytes ? toArrayBuffer(bytes) : undefined,
      };
    }
    return rec;
  }

  async function processDto(m: MessageDto): Promise<void> {
    if (room.sentIds.includes(m.id) || messages.has(m.id)) return;
    if (m.kind === "text") {
      if (typeof m.ct !== "string") return;
      const bytes = base64ToBytes(m.ct);
      if (!bytes) return;
      const wire = await decodeBlob(m.ts, bytes);
      if (!wire) return;
      const rec = wireToRecord(m.id, wire);
      messages.set(m.id, rec);
      await msgPut(rec);
      return;
    }
    // 画像: プレースホルダを置き、表示時に A6 で暗号文を遅延取得
    messages.set(m.id, {
      roomId,
      rowid: m.id,
      ts: m.ts,
      kind: "image",
      name: "…",
      receivedAt: Date.now(),
    });
    void loadImage(m.id);
  }

  async function loadImage(rowid: number): Promise<void> {
    if (imageLoading.has(rowid)) return;
    imageLoading.add(rowid);
    try {
      const res = await api.messageData(roomId, auth, rowid);
      const bytes = base64ToBytes(res.ct);
      if (!bytes) return;
      const wire = await decodeBlob(messages.get(rowid)?.ts ?? Date.now(), bytes);
      if (!wire) return;
      const rec = wireToRecord(rowid, wire);
      messages.set(rowid, rec);
      await msgPut(rec);
      render();
    } catch {
      /* 次回 render 時に再試行 */
    } finally {
      imageLoading.delete(rowid);
    }
  }

  // ---------- 送信 ----------
  async function encryptWire(wire: WireMessage): Promise<string> {
    const key = await deriveMessageKey(room.kr, room.pin, wire.ts);
    return bytesToBase64(await encryptMessage(key, wire.ts, encodeMessage(wire)));
  }

  async function sendWire(wire: WireMessage, tempId: number): Promise<void> {
    try {
      const ct = await encryptWire(wire);
      const { id } = await api.postMessage(roomId, auth, {
        ts: wire.ts,
        kind: wire.kind,
        ct,
      });
      await msgDelete(roomId, tempId);
      messages.delete(tempId);
      const rec = wireToRecord(id, wire);
      messages.set(id, rec);
      await msgPut(rec);
      await roomAddSentId(roomId, id);
      if (room.lastId < id) {
        room.lastId = id;
        await roomPut(room);
      }
    } catch (e) {
      await msgDelete(roomId, tempId);
      messages.delete(tempId);
      sendNote.textContent =
        e instanceof ApiError && (e.status === 403 || e.status === 404)
          ? "ルームに参加できない状態です。ページを開き直してください"
          : "送信に失敗しました。時間をおいて再試行してください";
      sendNote.hidden = false;
    } finally {
      render();
    }
  }

  async function sendText(): Promise<void> {
    const body = textarea.value.trim();
    if (!isText(body)) return;
    textarea.value = "";
    counter.textContent = `0/${TEXT_MAX}`;
    sendNote.hidden = true;
    const wire: WireMessage = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      kind: "text",
      name: room.name,
      ts: Date.now(),
      body,
    };
    const tempId = -Date.now();
    const rec = wireToRecord(tempId, wire);
    rec.pending = true;
    messages.set(tempId, rec);
    await msgPut(rec);
    render();
    await sendWire(wire, tempId);
  }

  async function sendImage(file: File): Promise<void> {
    sendNote.hidden = true;
    let compressed;
    try {
      compressed = await compressImage(file);
    } catch {
      sendNote.textContent = `画像を ${Math.floor(IMAGE_MAX_BYTES / 1024)}KB 以下に圧縮できませんでした`;
      sendNote.hidden = false;
      return;
    }
    const wire: WireMessage = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      kind: "image",
      name: room.name,
      ts: Date.now(),
      body: {
        d: bytesToBase64(new Uint8Array(compressed.bytes)),
        m: "image/webp",
        n: compressed.fileName,
      },
    };
    const tempId = -Date.now();
    const rec = wireToRecord(tempId, wire);
    rec.pending = true;
    messages.set(tempId, rec);
    await msgPut(rec);
    render();
    await sendWire(wire, tempId);
  }

  // ---------- ポーリング（FR-4） ----------
  const doSync = async (): Promise<boolean> => {
    if (fatal) return true;
    try {
      let after = room.lastId;
      for (;;) {
        const res = await api.listMessages(roomId, auth, after, PAGE_LIMIT_MAX);
        for (const m of res.messages) {
          await processDto(m);
          if (m.id > after) after = m.id;
        }
        if (res.messages.length < PAGE_LIMIT_MAX) break;
      }
      if (after !== room.lastId) {
        room.lastId = after;
        await roomPut(room);
      }
      render();
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        fatal = true;
        poller?.stop();
        banner.textContent =
          e.status === 404
            ? "このルームは削除されたか、有効期限切れです"
            : "認証に失敗しました。ページを開き直してください";
        banner.hidden = false;
        return true;
      }
      return false;
    }
  };

  poller = startPolling(doSync);
  render();

  if (notifySupported() && Notification.permission === "granted") {
    void ensureSubscription(room, auth).then(
      () => roomPut(room),
      () => {},
    );
  }
}
