/** 受け入れ基準2: 誤 PIN 拒否・正 PIN 参加（FR-2）＋ 再訪時の PIN 不要化（FR-1.5 / 設計 §6.6） */
import { randomBytes, randomUUID } from "node:crypto";
import { expect, test, type Browser } from "@playwright/test";
import { createRoom, joinRoom, ROOM_ID_RE } from "./app.ts";

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

test("誤 PIN は拒否され、正しい PIN では参加できる", async ({ browser, context }) => {
  const host = await context.newPage();
  const invite = await createRoom(host, "ホスト");

  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await gp.goto(invite.link);
  await expect(gp.locator("#join-form")).toBeVisible();

  // 誤 PIN（FR-2.2）
  const wrong = invite.pin === "000000" ? "000001" : "000000";
  await gp.fill("#j-name", "ゲスト");
  await gp.fill("#j-pin", wrong);
  await gp.click("#j-join");
  await expect(gp.locator(".err:visible")).toHaveText("招待リンクまたはPINが正しくありません", {
    timeout: 10_000,
  });
  await expect(gp.locator("#composer-text")).toHaveCount(0);
  await expect(gp.locator("#join-form")).toBeVisible();

  // 正しい PIN
  await gp.fill("#j-pin", invite.pin);
  await gp.click("#j-join");
  await expect(gp.locator("#composer-text")).toBeVisible({ timeout: 15_000 });
  await expect(gp).toHaveURL(new RegExp(invite.roomId));
  await guest.close();
  await host.close();
});

test("参加済みのブラウザは再訪時に PIN 入力を求められない（同じブラウザ限定）", async ({
  browser,
  context,
}) => {
  const host = await context.newPage();
  const invite = await createRoom(host, "再訪ホスト");

  const guest = await browser.newContext();
  const gp = await guest.newPage();
  await joinRoom(gp, invite, "ゲスト", invite.pin);
  await expect(gp.locator("#composer-text")).toBeVisible({ timeout: 15_000 });

  // K_R・PIN・表示名が IndexedDB に保存されている（FR-7.1）
  const stored = await gp.evaluate(
    (rid) =>
      new Promise<{ kr: number; pin: string; name: string } | null>((resolve) => {
        const open = indexedDB.open("tempchat", 1);
        open.onsuccess = () => {
          const db = open.result;
          const req = db.transaction("rooms", "readonly").objectStore("rooms").get(rid);
          req.onsuccess = () => {
            const r = req.result as { kr: ArrayBuffer; pin: string; name: string } | undefined;
            resolve(r ? { kr: r.kr.byteLength, pin: r.pin, name: r.name } : null);
          };
          req.onerror = () => resolve(null);
        };
      }),
    invite.roomId,
  );
  expect(stored).toEqual({ kr: 32, pin: invite.pin, name: "ゲスト" });

  // 再訪（URL にフラグメントなし）でも鍵保持のため即チャット
  await gp.goto(`/${invite.roomId}`);
  await expect(gp.locator("#composer-text")).toBeVisible({ timeout: 15_000 });
  await expect(gp.locator("#join-form")).toHaveCount(0);

  // 新しいブラウザ（別コンテキスト）では毎回 PIN 入力が必要（FR-2.2）
  const fresh = await browser.newContext();
  const fp = await fresh.newPage();
  await fp.goto(invite.link);
  await expect(fp.locator("#join-form")).toBeVisible();
  await fresh.close();
  await guest.close();
  await host.close();
});

test("招待リンクのフラグメント欠落は参加できない（FR-2.1）", async ({ browser, context }) => {
  const host = await context.newPage();
  const invite = await createRoom(host, "フラグメント");
  const bare = invite.link.split("#")[0]!;

  const other = await browser.newContext();
  const p = await other.newPage();
  await p.goto(bare);
  await expect(p.locator("text=無効なリンクです")).toBeVisible();
  await expect(p.locator("#join-form")).toHaveCount(0);
  await other.close();
  await host.close();
});

test("存在しないルーム・消滅ルームはエラー表示（FR-2.3）", async ({ browser }) => {
  const other = await browser.newContext();
  const p = await other.newPage();

  // 見た目は有効な UUID v4 + 妥当な長さの鍵フラグメント（まだ存在しないルーム）
  const uuid = randomUUID();
  await p.goto(`/${uuid}#${b64url(randomBytes(32))}`);
  // 参加を試みたときに 404 がエラー表示になる（FR-2.3）
  await expect(p.locator("#join-form")).toBeVisible({ timeout: 15_000 });
  await p.fill("#j-name", "存在しない");
  await p.fill("#j-pin", "123456");
  await p.click("#j-join");
  await expect(p.locator("text=ルームが存在しないか、削除されています")).toBeVisible({
    timeout: 15_000,
  });
  await expect(p.locator("#composer-text")).toHaveCount(0);

  // 形式不正のパスは別のエラーメッセージ
  await p.goto("/not-a-room");
  await expect(p.locator("text=ページが見つかりません")).toBeVisible();
  await other.close();
});

test("参加要求はヘッダにハッシュのみを運び、URL・ボディに鍵と PIN を載せない", async ({
  browser,
  context,
}) => {
  const host = await context.newPage();
  const invite = await createRoom(host, "輸送検査");
  const krFragment = new URL(invite.link).hash.slice(1);

  const other = await browser.newContext();
  const p = await other.newPage();
  const seen: { url: string; auth: string | null; body: string | null }[] = [];
  p.on("request", (req) => {
    if (!req.url().includes("/api/")) return;
    seen.push({
      url: req.url(),
      auth: req.headers()["x-room-auth"] ?? null,
      body: req.postData(),
    });
  });
  await joinRoom(p, invite, "ゲスト", invite.pin);
  await expect(p.locator("#composer-text")).toBeVisible({ timeout: 15_000 });

  const join = seen.find((s) => s.url.endsWith("/join"));
  expect(join).toBeDefined();
  expect(join!.auth).toMatch(/^[0-9a-f]{64}$/);
  expect(join!.body).toBe("{}");
  for (const s of seen) {
    expect(s.url).not.toContain(krFragment);
    expect(s.url).not.toContain(invite.pin);
    expect(s.url).not.toContain("#");
    expect(s.body ?? "").not.toContain(invite.pin);
    expect(s.body ?? "").not.toContain(krFragment);
  }
  // 参加で使ったハッシュはルームID とは別に、毎回ヘッダで提示される（FR-4.3）
  const list = seen.find((s) => s.url.includes("/messages?"));
  expect(list?.auth).toMatch(/^[0-9a-f]{64}$/);
  await other.close();
  await host.close();
});
