/** ルーム参加（PIN入力）画面（FR-2 / 設計 §6.6） */

import type { RoomRecord } from "../idb.ts";
import { roomAuthHash } from "../../shared/crypto.ts";
import { api, ApiError } from "../api.ts";
import { roomPut } from "../idb.ts";
import { requestPermissionWithinGesture } from "../notify.ts";
import { clear, h } from "../ui.ts";

export function renderJoin(
  app: HTMLElement,
  roomId: string,
  kr: Uint8Array,
  onDone: () => void,
): void {
  clear(app);
  let busy = false;

  const nameInput = h("input", {
    type: "text",
    maxlength: "20",
    placeholder: "あなたの名前（1〜20文字）",
    class: "input",
    id: "j-name",
  });
  const pinInput = h("input", {
    type: "text",
    inputmode: "numeric",
    pattern: "[0-9]*",
    class: "input",
    placeholder: "PIN（6〜12桁の数字）",
    id: "j-pin",
  });
  const error = h("p", { class: "err", hidden: true });
  const submit = h("button", { class: "btn btn-primary", type: "submit", id: "j-join" }, "参加する");

  const form = h(
    "form",
    { class: "card form", id: "join-form" },
    h("h1", { class: "title" }, "ルームに参加"),
    h("p", { class: "sub" }, "共有されたPINを入力してください。招待リンクとは別に受け取った6〜12桁の数字です。"),
    nameInput,
    pinInput,
    error,
    submit,
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void doJoin();
  });

  async function doJoin(): Promise<void> {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    try {
      const name = nameInput.value.trim();
      if ([...name].length < 1 || [...name].length > 20) {
        error.textContent = "名前を1〜20文字で入力してください";
        error.hidden = false;
        return;
      }
      const pin = pinInput.value;
      if (!/^[0-9]{6,12}$/.test(pin)) {
        error.textContent = "PINは6〜12桁の数字です";
        error.hidden = false;
        return;
      }
      requestPermissionWithinGesture(); // FR-2.4
      const auth = await roomAuthHash(kr, pin);
      await api.join(roomId, auth);
      const rec: RoomRecord = {
        roomId,
        kr,
        pin,
        name,
        createdAt: Date.now(),
        lastId: 0,
        sentIds: [],
      };
      await roomPut(rec);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        error.textContent = "招待リンクまたはPINが正しくありません";
      } else if (e instanceof ApiError && e.status === 404) {
        error.textContent = "ルームが存在しないか、削除されています";
      } else {
        error.textContent = "参加に失敗しました。時間をおいて再試行してください";
      }
      error.hidden = false;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  app.append(h("div", { class: "screen" }, form));
  nameInput.focus();
}
