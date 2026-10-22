/** アプリエントリ・ルーティング（設計 §7.1） */

import { base64UrlToBytes } from "./../shared/bytes.ts";
import { UUID_V4_RE } from "../shared/constants.ts";
import { clear, h } from "./ui.ts";
import { renderCreate } from "./views/create.ts";
import { renderJoin } from "./views/join.ts";
import { renderChat } from "./views/chat.ts";
import { applyTheme } from "./theme.ts";
import { roomGet } from "./idb.ts";
import "./style.css";

const app = document.getElementById("app");
if (!app) throw new Error("no #app");

function renderError(message: string): void {
  clear(app!);
  app!.append(
    h(
      "div",
      { class: "screen" },
      h("div", { class: "card form" }, h("h1", { class: "title" }, "tempchat"), h("p", { class: "err" }, message)),
    ),
  );
}

async function route(): Promise<void> {
  applyTheme();
  const path = location.pathname.replace(/\/+$/, "");
  if (path === "") {
    renderCreate(app!, route);
    return;
  }
  const m = path.match(/^\/([^/]+)$/);
  if (m && UUID_V4_RE.test((m[1] ?? "").toLowerCase())) {
    const roomId = (m[1] as string).toLowerCase();
    const stored = await roomGet(roomId);
    if (stored) {
      await renderChat(app!, roomId, () => void route());
      return;
    }
    const kr = parseKr(location.hash);
    if (kr) {
      renderJoin(app!, roomId, kr, () => void route());
      return;
    }
    renderError("無効なリンクです。招待リンク全体を開いてください。");
    return;
  }
  renderError("ページが見つかりません。招待リンクを確認してください。");
}

/** URLフラグメントから K_R を復元（FR-2.1。フラグメントはサーバに送信されない） */
function parseKr(hash: string): Uint8Array | null {
  const s = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!s) return null;
  try {
    return base64UrlToBytes(decodeURIComponent(s));
  } catch {
    return null;
  }
}

window.addEventListener("popstate", () => void route());

// Service Worker 登録は https / localhost のみ（設計 §11）
if (
  "serviceWorker" in navigator &&
  (location.protocol === "https:" ||
    location.hostname === "localhost" ||
    location.hostname === "127.0.0.1")
) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}

void route();
