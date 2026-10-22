/** ルーム作成画面（FR-1 / 設計 §7.1） */

import { bytesToBase64Url, randomBytes } from "../../shared/bytes.ts";
import { roomAuthHash } from "../../shared/crypto.ts";
import { api, ApiError } from "../api.ts";
import { roomPut } from "../idb.ts";
import { requestPermissionWithinGesture } from "../notify.ts";
import { PIN_MAX, PIN_MIN } from "../../shared/constants.ts";
import { clear, h } from "../ui.ts";

function genPin(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return String(100000 + (Number(b[0]) % 900000));
}

export function renderCreate(
  app: HTMLElement,
  onDone: () => void,
): void {
  clear(app);
  let pin = genPin();
  let busy = false;

  const nameInput = h("input", {
    type: "text",
    maxlength: "20",
    placeholder: "あなたの名前（1〜20文字）",
    class: "input",
    id: "c-name",
  });
  const pinInput = h("input", {
    type: "text",
    inputmode: "numeric",
    pattern: "[0-9]*",
    class: "input pin-input",
    value: pin,
    id: "c-pin",
  });
  const pinError = h("p", { class: "err", hidden: true });
  const regen = h(
    "button",
    { class: "btn btn-ghost", type: "button", id: "c-regen" },
    "再生成",
  );
  const error = h("p", { class: "err", hidden: true });
  const submit = h("button", { class: "btn btn-primary", type: "submit", id: "c-create" }, "ルームを作成");

  regen.addEventListener("click", () => {
    pin = genPin();
    pinInput.value = pin;
    pinError.hidden = true;
  });

  const form = h(
    "form",
    { class: "card form", id: "create-form" },
    h("h1", { class: "title" }, "tempchat"),
    h("p", { class: "sub" }, "アカウント不要のE2EE一時チャット。まず名前を決めてルームを作成します。"),
    nameInput,
    h(
      "label",
      { class: "field" },
      "参加用PIN（6〜12桁の数字。リンクとは別に共有）",
      h("div", { class: "row" }, pinInput, regen),
      pinError,
    ),
    error,
    submit,
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submitCreate();
  });

  async function submitCreate(): Promise<void> {
    if (busy) return;
    busy = true;
    submit.disabled = true;
    error.hidden = true;
    pinError.hidden = true;
    try {
      const name = nameInput.value.trim();
      if ([...name].length < 1 || [...name].length > 20) {
        throw new Error("name");
      }
      pin = pinInput.value;
      if (!/^[0-9]+$/.test(pin) || pin.length < PIN_MIN || pin.length > PIN_MAX) {
        pinError.textContent = `PINは${PIN_MIN}〜${PIN_MAX}桁の数字で入力してください`;
        pinError.hidden = false;
        return;
      }
      requestPermissionWithinGesture(); // FR-2.4 ジェスチャ内で許可要求
      const kr = randomBytes(32);
      const keyHash = await roomAuthHash(kr, pin);
      const { roomId } = await api.createRoom(keyHash);
      await roomPut({
        roomId,
        kr,
        pin,
        name,
        createdAt: Date.now(),
        lastId: 0,
        sentIds: [],
      });
      history.replaceState(null, "", `/${roomId}#${bytesToBase64Url(kr)}`);
      onDone();
    } catch (err) {
      if (err instanceof Error && err.message === "name") {
        error.textContent = "名前を1〜20文字で入力してください";
      } else if (err instanceof ApiError) {
        error.textContent = "作成に失敗しました。時間をおいて再試行してください";
      } else {
        error.textContent = "エラーが発生しました";
      }
      error.hidden = false;
    } finally {
      busy = false;
      submit.disabled = false;
    }
  }

  app.append(
    h("div", { class: "screen" }, form),
  );
  nameInput.focus();
}
