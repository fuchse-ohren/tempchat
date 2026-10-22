/** E2E 共通ヘルパ（画面は design §7.1 / 実装の DOM id を使う） */
import { expect, type Page } from "@playwright/test";

export const ROOM_ID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/;

export interface Invite {
  roomId: string;
  link: string;
  pin: string;
}

export interface Bubble {
  name: string;
  text: string;
  fileName: string;
  hasImage: boolean;
  imageSrc: string;
  imgWidth: number;
}

/** 作成画面でルームを作る（FR-1） */
export async function createRoom(
  page: Page,
  name = "ホスト",
  pin?: string,
): Promise<Invite> {
  await page.goto("/");
  await page.fill("#c-name", name);
  if (pin) await page.fill("#c-pin", pin);
  await page.click("#c-create");
  await expect(page.locator("#msg-list")).toBeVisible({ timeout: 20_000 });
  await page.waitForURL(/#[A-Za-z0-9_-]{43}$/, { timeout: 20_000 });
  return readInvite(page);
}

/** 招待パネルを開いてリンクと PIN を読む（FR-1.2 / 設計 §7.1） */
export async function readInvite(page: Page): Promise<Invite> {
  await page.click("#btn-invite");
  const codes = page.locator(".panel .code");
  await expect(codes).toHaveCount(2, { timeout: 10_000 });
  const link = normalizeCodeSpace(await codes.nth(0).innerText());
  const pin = normalizeCodeSpace(await codes.nth(1).innerText());
  await page.locator(".panel .panel-head button").click();
  const roomId = new URL(link).pathname.replace(/^\/+|\/+$/g, "");
  return { roomId, link, pin };
}

/** 折り返し・空白混入を防ぐための正規化（表示上の改行は除く） */
function normalizeCodeSpace(s: string): string {
  return s.replace(/\s+/g, "");
}

/** 招待リンクから参加する（FR-2） */
export async function joinRoom(
  page: Page,
  invite: Invite | string,
  name: string,
  pin: string,
): Promise<void> {
  const link = typeof invite === "string" ? invite : invite.link;
  await page.goto(link);
  await expect(page.locator("#join-form")).toBeVisible({ timeout: 20_000 });
  await page.fill("#j-name", name);
  await page.fill("#j-pin", pin);
  await page.click("#j-join");
}

/** テキストを送る（FR-3） */
export async function sendText(page: Page, text: string): Promise<void> {
  await page.bringToFront();
  await expect(page.locator("#composer-text")).toBeVisible({ timeout: 10_000 });
  await page.fill("#composer-text", text);
  await page.click("#btn-send");
}

/** 描画済みのメッセージを読む */
export async function bubbles(page: Page): Promise<Bubble[]> {
  return page.locator("#msg-list > li.msg").evaluateAll((lis) =>
    lis.map((li) => {
      const img = li.querySelector("img.msg-image") as HTMLImageElement | null;
      return {
        name: li.querySelector(".msg-name")?.textContent ?? "",
        text: li.querySelector(".msg-text")?.textContent ?? "",
        fileName:
          li.querySelector(".msg-file")?.textContent ?? img?.getAttribute("alt") ?? "",
        hasImage: !!img,
        imageSrc: img?.getAttribute("src") ?? "",
        imgWidth: img?.naturalWidth ?? 0,
      };
    }),
  );
}

/**
 * 条件を満たすメッセージが描画されるまで待つ。
 * ポーリングは可視中のみなので、待つページを前面にしてから poll する（handoff §6）。
 * 戻り値は命中までのミリ秒（FR-4.1 の 5 秒要件の実測用）。
 */
export async function waitForBubble(
  page: Page,
  label: string,
  predicate: (b: Bubble) => boolean,
  timeoutMs = 20_000,
): Promise<{ elapsedMs: number; bubble: Bubble }> {
  await page.bringToFront();
  const started = Date.now();
  for (;;) {
    const found = (await bubbles(page)).filter(predicate);
    if (found.length > 0) return { elapsedMs: Date.now() - started, bubble: found[0]! };
    if (Date.now() - started > timeoutMs) {
      const seen = await bubbles(page);
      throw new Error(
        `${label}: ${timeoutMs}ms 以内に現れませんでした。現在 = ${JSON.stringify(seen)}`,
      );
    }
    await page.waitForTimeout(200);
  }
}

/** IndexedDB のメッセージ生データ（FR-7.1 / 受け入れ基準7 の「ローカルに残る」確認） */
export async function idbMessages(
  page: Page,
  roomId: string,
): Promise<
  {
    rowid: number;
    ts: number;
    kind: string;
    name: string;
    text?: string;
    image?: { mime: string; bytes: number; fileName: string };
  }[]
> {
  return page.evaluate(async (rid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tempchat", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction("messages", "readonly");
      const req = tx
        .objectStore("messages")
        .index("by_room")
        .getAll(IDBKeyRange.only(rid));
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return rows.map((raw) => {
      const m = raw as {
        rowid: number;
        ts: number;
        kind: string;
        name: string;
        text?: string;
        image?: { mime: string; bytes?: ArrayBuffer; fileName: string };
      };
      return {
        rowid: m.rowid,
        ts: m.ts,
        kind: m.kind,
        name: m.name,
        text: m.text,
        image: m.image
          ? {
              mime: m.image.mime,
              bytes: m.image.bytes?.byteLength ?? 0,
              fileName: m.image.fileName,
            }
          : undefined,
      };
    });
  }, roomId);
}

/** IndexedDB のルーム鍵情報（K_R・PIN・表示名がブラウザ側にあるか FR-7.1） */
export async function idbRoom(
  page: Page,
  roomId: string,
): Promise<{
  roomId: string;
  krBytes: number;
  pin: string;
  name: string;
  lastId: number;
  sentIds: number[];
} | null> {
  return page.evaluate(async (rid) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tempchat", 1);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rec = await new Promise<unknown | undefined>((resolve, reject) => {
      const tx = db.transaction("rooms", "readonly");
      const req = tx.objectStore("rooms").get(rid);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!rec) return null;
    const r = rec as {
      roomId: string;
      kr: ArrayBuffer;
      pin: string;
      name: string;
      lastId: number;
      sentIds: number[];
    };
    return {
      roomId: r.roomId,
      krBytes: r.kr?.byteLength ?? 0,
      pin: r.pin,
      name: r.name,
      lastId: r.lastId,
      sentIds: r.sentIds,
    };
  }, roomId);
}


/** テキストをまとめて送信する（スクロール検証用の履歴作り。送信成功まで待ってから次へ） */
export async function fillConversation(
  page: Page,
  count: number,
  makeText: (i: number) => string,
): Promise<void> {
  await page.bringToFront();
  const box = page.locator("#composer-text");
  const btn = page.locator("#btn-send");
  await expect(box).toBeVisible({ timeout: 10_000 });
  for (let i = 1; i <= count; i++) {
    await box.fill(makeText(i));
    await btn.click();
    await expect(box).toHaveValue("");
  }
}

/** メッセージ一覧のスクロール状態 */
export async function scrollInfo(
  page: Page,
): Promise<{ top: number; max: number; count: number }> {
  return page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("#msg-list");
    if (!el) throw new Error("#msg-list がない");
    return {
      top: Math.round(el.scrollTop),
      max: Math.round(el.scrollHeight - el.clientHeight),
      count: el.children.length,
    };
  });
}

/** 一覧を先頭まで遡る（過去を閲覧中の状態を作る） */
export async function scrollMessagesToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>("#msg-list");
    if (!el) throw new Error("#msg-list がない");
    el.scrollTop = 0;
  });
}
