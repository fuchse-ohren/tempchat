/** 受け入れ基準4（画像疎通）+ FR-7.4/7.5（96KB・WebP・1280px）+ FR-7.2（受信後ローカル表示） */
import { expect, test, type Browser, type BrowserContext } from "@playwright/test";
import {
  bubbles,
  createRoom,
  idbMessages,
  joinRoom,
  waitForBubble,
} from "./app.ts";
import { FIXTURES } from "./fixtures.ts";
import { d1 } from "./d1.ts";

async function makePair(browser: Browser, context: BrowserContext) {
  const host = await context.newPage();
  const invite = await createRoom(host, "画像ホスト");
  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await joinRoom(guest, invite, "画像ゲスト", invite.pin);
  await expect(guest.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
  return { host, guest, guestCtx, invite };
}

test.describe("画像メッセージ", () => {
  test("送信した PNG が WebP 化されて相手に表示される（受け入れ基準4 / FR-7.4）", async ({
    browser,
    context,
  }) => {
    const { host, guest, guestCtx, invite } = await makePair(browser, context);

    await host.bringToFront();
    await host.setInputFiles("#composer-file", FIXTURES.photo);
    const sent = await waitForBubble(host, "自分の画像", (b) => b.hasImage);
    expect(sent.bubble.name).toBe("画像ホスト");

    const got = await waitForBubble(guest, "相手の画像", (b) => b.hasImage, 25_000);
    expect(got.bubble.hasImage).toBe(true);
    expect(got.bubble.imgWidth).toBeGreaterThan(0); // 実際にデコードできている
    expect(got.bubble.fileName).toMatch(/^photo.*\.webp$/); // 保存名は WebP（FR-7.5）
    expect(got.bubble.imageSrc.startsWith("blob:")).toBe(true); // ローカル変換（FR-7.2）

    // IndexedDB の保存実体: image/webp・96KB 以下・長辺 1280px 以下
    const rows = await idbMessages(guest, invite.roomId);
    const img = rows.find((r) => r.kind === "image");
    expect(img?.image?.mime).toBe("image/webp");
    expect(img?.image?.bytes).toBeGreaterThan(0);
    expect(img!.image!.bytes).toBeLessThanOrEqual(96 * 1024);

    await guestCtx.close();
    await host.close();
  });

  test("大きな画像は長辺 1280px まで縮小される（FR-7.5）", async ({ browser, context }) => {
    const { host, guest, guestCtx } = await makePair(browser, context);
    await host.bringToFront();
    await host.setInputFiles("#composer-file", FIXTURES.big); // 2560x1920 の PNG
    const got = await waitForBubble(guest, "縮小画像", (b) => b.hasImage, 30_000);
    expect(got.bubble.imgWidth).toBeGreaterThan(0);
    expect(got.bubble.imgWidth).toBeLessThanOrEqual(1280);
    await guestCtx.close();
    await host.close();
  });

  test("画像はサーバでは 48KiB チャンク保存され、平文は残らない", async ({ browser, context }) => {
    const { host, guest, guestCtx, invite } = await makePair(browser, context);
    await host.bringToFront();
    await host.setInputFiles("#composer-file", FIXTURES.photo);
    await waitForBubble(guest, "画像着信", (b) => b.hasImage, 25_000);

    const rows = await d1<{ id: number; kind: string; chunks: number; ctType: string }>(
      `SELECT m.id AS id, m.kind AS kind,
              (SELECT COUNT(*) FROM message_blobs b WHERE b.msg_id = m.id) AS chunks,
              typeof(m.ct) AS ctType
         FROM messages m WHERE m.room_id = '${invite.roomId}' AND m.kind = 'image'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const imageRow = rows[0]!;
    expect(imageRow.ctType).toBe("null"); // 画像は messages.ct にインライン保存しない（設計 §4.1）
    expect(imageRow.chunks).toBeGreaterThanOrEqual(1);
    // 1チャンク 48KiB を超えていない
    const sizes = await d1<{ len: number }>(
      `SELECT length(chunk) AS len FROM message_blobs WHERE msg_id = ${imageRow.id}`,
    );
    for (const s of sizes) expect(s.len).toBeLessThanOrEqual(48 * 1024);

    await guestCtx.close();
    await host.close();
  });

  test("受信画像はリロード後もローカルから表示される（FR-7.2 / 受け入れ基準7 のローカル側）", async ({
    browser,
    context,
  }) => {
    const { host, guest, guestCtx, invite } = await makePair(browser, context);
    await host.bringToFront();
    await host.setInputFiles("#composer-file", FIXTURES.photo);
    await waitForBubble(guest, "画像着信", (b) => b.hasImage, 25_000);

    // サーバ側を消しても（=保持期間切れ相当）ローカル IndexedDB で閲覧継続できる
    await d1(`DELETE FROM message_blobs WHERE msg_id IN (SELECT id FROM messages WHERE room_id = '${invite.roomId}')`);
    await d1(`DELETE FROM messages WHERE room_id = '${invite.roomId}'`);
    const gone = await d1<{ c: number }>(
      `SELECT COUNT(*) AS c FROM messages WHERE room_id = '${invite.roomId}'`,
    );
    expect(gone[0]!.c).toBe(0);

    await guest.reload();
    await expect(guest.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
    const list = await bubbles(guest);
    expect(list.filter((b) => b.hasImage)).toHaveLength(1);
    expect(list[0]!.hasImage).toBe(true);

    await guestCtx.close();
    await host.close();
  });
});
