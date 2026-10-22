/**
 * 受け入れ基準4（テキスト疎通）: 受け入れ基準5（途中参加の履歴）
 * 併せて FR-3.7（400文字上限）・FR-3.5（並び順）・FR-3.6（二重表示排除）・FR-4.1（ポーリング）を検証する
 */
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import {
  bubbles,
  createRoom,
  fillConversation,
  idbMessages,
  joinRoom,
  scrollInfo,
  scrollMessagesToTop,
  sendText,
  waitForBubble,
  type Invite,
} from "./app.ts";

const HOST = "ホスト花子";
const GUEST = "ゲスト太郎";

async function makePair(browser: Browser, context: BrowserContext) {
  const host = await context.newPage();
  const invite = await createRoom(host, HOST);
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await joinRoom(guest, invite, GUEST, invite.pin);
  await expect(guest.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
  return { host, guest, guestCtx, invite };
}

test.describe("双方向テキスト疎通", () => {
  test("ホスト→ゲスト、ゲスト→ホストが双方の画面に出る", async ({ browser, context }) => {
    const { host, guest, guestCtx } = await makePair(browser, context);
    const stamp = Date.now();
    const hostMsg = `ホストからの用件 ${stamp}`;
    const guestMsg = `ゲストからの返事 ${stamp}`;

    await sendText(host, hostMsg);
    const r1 = await waitForBubble(guest, "ゲスト側に着信", (b) => b.text === hostMsg);
    expect(r1.bubble.name).toBe(HOST);
    // FR-4.1: 可視中は 5 秒以内に新着が反映される（＋余裕を持った上限）
    expect(r1.elapsedMs).toBeLessThan(9_000);

    await sendText(guest, guestMsg);
    const r2 = await waitForBubble(host, "ホスト側に着信", (b) => b.text === guestMsg);
    expect(r2.bubble.name).toBe(GUEST);
    expect(r2.elapsedMs).toBeLessThan(9_000);

    // 送信者は自分の送信を二重表示しない（FR-3.6）
    await host.waitForTimeout(6_000); // 1 ポーリング分以上待つ
    expect((await bubbles(host)).filter((b) => b.text === hostMsg)).toHaveLength(1);
    expect((await bubbles(guest)).filter((b) => b.text === guestMsg)).toHaveLength(1);

    // 並べ替えは送信タイムスタンプ昇順（FR-3.5）
    const list = await bubbles(guest);
    const idxHost = list.findIndex((b) => b.text === hostMsg);
    const idxGuest = list.findIndex((b) => b.text === guestMsg);
    expect(idxGuest).toBeGreaterThan(idxHost);

    await guestCtx.close();
    await host.close();
  });

  test("400文字は送信でき、401文字はクライアントで送信を止める（FR-3.7）", async ({
    browser,
    context,
  }) => {
    const { host, guest, guestCtx } = await makePair(browser, context);
    const marker = Date.now();
    const body400 = `あ${"x".repeat(399)}`.slice(0, 400);
    expect([...body400]).toHaveLength(400);

    await host.bringToFront();
    await host.fill("#composer-text", body400);
    await expect(host.locator(".counter")).toHaveText("400/400");
    await host.click("#btn-send");
    const got = await waitForBubble(guest, "400文字メッセージ", (b) =>
      b.text.startsWith("あxxx"),
    );
    expect([...got.bubble.text]).toHaveLength(400);
    void marker;

    // 401 文字を無理やり入れても送信されない（サーバにも届かない）
    const before = await bubbles(guest);
    await host.bringToFront();
    await host.evaluate(() => {
      const el = document.querySelector<HTMLTextAreaElement>("#composer-text")!;
      el.value = "y".repeat(401);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(host.locator(".counter")).toHaveText("401/400");
    await host.click("#btn-send");
    await host.waitForTimeout(1_500);
    expect(await bubbles(guest)).toHaveLength(before.length);
    // 入力欄にまだ残っている＝送信中として消えていない
    await expect(host.locator("#composer-text")).toHaveValue("y".repeat(401));

    // フォーム入力（max 属性）では 401 文字を入力できない
    await host.fill("#composer-text", "");
    await host.locator("#composer-text").pressSequentially("z".repeat(420), { delay: 0 });
    await expect(host.locator("#composer-text")).toHaveValue("z".repeat(400));

    await guestCtx.close();
    await host.close();
  });

  test("途中参加のゲストは保持期間内の過去メッセージを閲覧できる（受け入れ基準5）", async ({
    browser,
    context,
  }) => {
    const host = await context.newPage();
    const invite: Invite = await createRoom(host, HOST);
    const stamp = Date.now();
    for (const i of [1, 2, 3]) {
      await sendText(host, `履歴の1回目-${stamp}-${i}`);
    }
    await expect(host.locator("#msg-list > li.msg")).toHaveCount(3, { timeout: 15_000 });

    const lateCtx = await browser.newContext();
    const late = await lateCtx.newPage();
    await joinRoom(late, invite, "後から参加", invite.pin);
    await expect(late.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
    // FR-5.1: 参加時に保持期間内の全メッセージを一括取得して表示する
    await expect(late.locator("#msg-list > li.msg")).toHaveCount(3, { timeout: 20_000 });
    const list = await bubbles(late);
    expect(list.map((b) => b.text)).toEqual([
      `履歴の1回目-${stamp}-1`,
      `履歴の1回目-${stamp}-2`,
      `履歴の1回目-${stamp}-3`,
    ]);
    expect(list.every((b) => b.name === HOST)).toBe(true);
    await lateCtx.close();
    await host.close();
  });

  test("メッセージは IndexedDB に復号済みで保存される（FR-4.2・FR-7.1）", async ({
    browser,
    context,
  }) => {
    const { host, guest, guestCtx, invite } = await makePair(browser, context);
    const text = `保存確認 ${Date.now()}`;
    await sendText(host, text);
    await waitForBubble(guest, "着信", (b) => b.text === text);

    const rows = await idbMessages(guest, invite.roomId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "text", name: HOST, text });
    expect(rows[0]!.ts).toBeGreaterThan(1e12);
    expect(rows[0]!.rowid).toBeGreaterThan(0);

    // リロード後も再表示される（FR-7.1）
    await guest.reload();
    await expect(guest.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
    await expect(guest.locator(`#msg-list >> text=${text}`)).toBeVisible();
    expect(await idbMessages(guest, invite.roomId)).toHaveLength(1);

    await guestCtx.close();
    await host.close();
  });

  test("送信失敗時は「送信失敗」表示で本文が残るので、そのまま再送できる（設計 §6.3）", async ({
    page,
  }) => {
    await createRoom(page, "再送ホスト");
    // 送信 POST だけ失敗させる（受信の GET は通す）
    await page.route("**/messages", async (route) => {
      if (route.request().method() === "POST") await route.abort();
      else await route.fallback();
    });

    const text = `再送する本文 ${Date.now()}`;
    await sendText(page, text);
    await expect(page.locator("li.msg.failed .msg-flag-fail")).toContainText("送信失敗");
    await expect(page.locator(".err:visible")).toContainText("送信に失敗しました");
    await expect(page.locator("#composer-text")).toHaveValue(text); // 下書きは捨てない

    // 通信が復旧したら同じ本文をそのまま再送できる（バブルは 1 件に収まる）
    await page.unroute("**/messages");
    await page.click("#btn-send");
    await expect(page.locator("#msg-list > li.msg")).toHaveCount(1, { timeout: 15_000 });
    await expect(page.locator("#msg-list .msg-text")).toHaveText(text);
    await expect(page.locator("li.msg.failed")).toHaveCount(0);
    await expect(page.locator("#composer-text")).toHaveValue("");
  });

  test("過去を遡っているときに新着が届いてもスクロール位置を維持する", async ({
    browser,
    context,
  }) => {
    const host = await context.newPage();
    const invite = await createRoom(host, "スクロール検証");
    const marker = Date.now();

    // 一覧がスクロールできる程度に履歴を作っておく（ゲスト参加前に）
    await fillConversation(host, 30, (i) => `遡及確認 ${marker} - ${i}`);
    await expect(host.locator("#msg-list > li.msg")).toHaveCount(30, { timeout: 30_000 });

    const guestCtx = await browser.newContext();
    const guest = await guestCtx.newPage();
    await joinRoom(guest, invite, "閲覧者", invite.pin);
    await expect(guest.locator("#msg-list > li.msg")).toHaveCount(30, { timeout: 40_000 });

    // 参加直後は最下部に表示されている
    const initial = await scrollInfo(guest);
    expect(initial.max).toBeGreaterThan(0);
    expect(initial.top).toBeGreaterThanOrEqual(initial.max - 2);

    // 先頭まで遡って過去を読む
    await scrollMessagesToTop(guest);
    expect((await scrollInfo(guest)).top).toBeLessThan(5);

    // 新着が届いても位置はそのまま（自動で最新へスクロールしない）
    await sendText(host, `新着マーカー ${marker}`);
    await waitForBubble(guest, "新着", (b) => b.text === `新着マーカー ${marker}`);
    const after = await scrollInfo(guest);
    expect(after.count).toBe(31);
    expect(after.top).toBeLessThan(5);

    // 自分の送信だけは最下部へ寄せる（打った直後の見え方）
    await sendText(guest, `自分の送信 ${marker}`);
    await expect(guest.locator("#msg-list > li.msg")).toHaveCount(32, { timeout: 20_000 });
    const mine = await scrollInfo(guest);
    expect(mine.top).toBeGreaterThanOrEqual(mine.max - 2);

    await guestCtx.close();
    await host.close();
  });

  test("ページが可視のあいだ 5 秒間隔でポーリングし、非可視なら停止する（FR-4.1）", async ({
    context,
  }) => {
    // headless では別タブの可視/非可視が切り替わらないため、visibilityState を
    // 差し替えて FR-4.1 の挙動を決定的に検証する（ポーリングは document を見る）
    await context.addInitScript(() => {
      let hidden = false;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => (hidden ? "hidden" : "visible"),
      });
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden,
      });
      const w = window as unknown as { __setHidden?: (v: boolean) => void };
      w.__setHidden = (v: boolean) => {
        hidden = v;
        document.dispatchEvent(new Event("visibilitychange"));
      };
    });
    const setHidden = (v: boolean) =>
      page.evaluate(
        (x) => (window as unknown as { __setHidden: (v: boolean) => void }).__setHidden(x),
        v,
      );

    const page = await context.newPage();
    let n = 0;
    page.on("request", (req) => {
      if (req.url().includes("/messages?after=")) n++;
    });
    await createRoom(page, "ポーリング検証");

    await page.waitForTimeout(1_200); // 初期同期を流す
    n = 0;
    await page.waitForTimeout(11_500); // 可視のまま約 2 ポーリング分
    const visible = n;
    expect(visible).toBeGreaterThanOrEqual(2);
    expect(visible).toBeLessThanOrEqual(4);

    // 非可視ならポーリングを停止（5 秒周期が止まる）
    await setHidden(true);
    n = 0;
    await page.waitForTimeout(11_500);
    expect(n).toBe(0);

    // 可視復帰時は即時同期する
    await setHidden(false);
    await expect.poll(() => n, { timeout: 5_000, message: "可視復帰の即時同期" }).toBeGreaterThan(0);
    await page.close();
  });
});
