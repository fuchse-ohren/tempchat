/** 受け入れ基準1: ルーム作成→UUID発行→招待リンク生成（FR-1）＋ D1 作成確認 */
import { expect, test } from "@playwright/test";
import { createRoom, readInvite, ROOM_ID_RE } from "./app.ts";
import { d1 } from "./d1.ts";

test("ルーム作成で UUID v4 が発行され、招待リンクと PIN が表示される", async ({ page }) => {
  const posted: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/rooms")) {
      posted.push(req.postData() ?? "");
    }
  });

  const invite = await createRoom(page, "ホスト太郎");

  // ルームID は UUID v4（要件 §9）
  expect(invite.roomId).toMatch(ROOM_ID_RE);
  // 招待リンクは <URL>/<ルームID>#<base64url(K_R)>（FR-1.2）
  const url = new URL(invite.link);
  expect(url.pathname).toBe(`/${invite.roomId}`);
  expect(url.hash).toMatch(/^#[A-Za-z0-9_-]{43}$/); // 32B を padding なし base64url
  expect(url.origin).toBe(new URL(page.url()).origin);
  // PIN は 6〜12 桁の数字（FR-1.1）
  expect(invite.pin).toMatch(/^[0-9]{6,12}$/);

  // サーバには H(K_R‖PIN) しか送っていない（FR-1.3 / 受け入れ基準3 の入口）
  expect(posted).toHaveLength(1);
  const body = JSON.parse(posted[0]!) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["keyHash"]);
  expect(String(body.keyHash)).toMatch(/^[0-9a-f]{64}$/);
  const json = JSON.stringify(body);
  expect(json).not.toContain(invite.pin);
  expect(json).not.toContain("ホスト太郎");
  expect(json).not.toContain(url.hash.slice(1));

  // 作成後、ブラウザは同じページで PIN を再入力せずチャットに入れる（FR-1.5）
  await expect(page.locator("#composer-text")).toBeVisible();
  await expect(page.locator("#join-form")).toHaveCount(0);
});

test("作成されたルームは D1 に key_hash(32B) だけで保存される（受け入れ基準3 の作成時）", async ({ page }) => {
  const invite = await createRoom(page, "DB確認");
  const rows = await d1<{ id: string; t: string; len: number; last: number | null }>(
    `SELECT id, typeof(key_hash) AS t, length(key_hash) AS len, last_msg_at AS last
       FROM rooms WHERE id = '${invite.roomId}'`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]!.t).toBe("blob");
  expect(rows[0]!.len).toBe(32);
  expect(rows[0]!.last).toBeNull();

  // 表示名も PIN も K_R も DB のどこにも存在しない
  const hits = await d1<{ n: number }>(
    `SELECT (SELECT COUNT(*) FROM rooms WHERE cast(key_hash AS BLOB) IS NULL) AS n`,
  );
  expect(hits[0]!.n).toBe(0);
  const rooms = await d1<{ c: number }>("SELECT COUNT(*) AS c FROM rooms WHERE id = 'DB確認'");
  expect(rooms[0]!.c).toBe(0);
});

test("招待リンクと PIN は設定から再表示できる（設計 §7.1）", async ({ page }) => {
  const first = await createRoom(page, "再表示");
  const again = await readInvite(page);
  expect(again.link).toBe(first.link);
  expect(again.pin).toBe(first.pin);
});

test("再訪（URL にフラグメントが無い）でも招待リンクは K_R を保持している（FR-1.2）", async ({
  page,
}) => {
  const invite = await createRoom(page, "再訪招待");
  await page.reload(); // /<roomId> だけ（フラグメントは再送されない）に戻す
  await expect(page.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
  const again = await readInvite(page);
  expect(again.link).toBe(invite.link); // K_R が落ちていない
  expect(new URL(again.link).hash).toMatch(/^#[A-Za-z0-9_-]{43}$/);
});

test("セキュリティヘッダが設計 §11 の方針を満たす（CSP・Referrer-Policy・noindex）", async ({
  page,
}) => {
  const res = await page.goto("/");
  const headers = res!.headers();
  const csp = headers["content-security-policy"] ?? "";
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  expect(csp).toContain("img-src 'self' blob: data:"); // 画像はローカル blob で表示
  expect(csp).not.toContain("unsafe-inline");
  expect(csp).not.toContain("unsafe-eval");
  expect(csp).not.toMatch(/https?:/); // 外部オリジンを許可しない
  expect(headers["referrer-policy"]).toBe("no-referrer"); // フラグメント漏えい防止
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-robots-tag"]).toContain("noindex");
  // robots.txt も Disallow
  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /");
});

test("Service Worker が配信・登録される（設計 §8 / FR-6 の前提）", async ({ page }) => {
  const sw = await page.request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(sw.headers()["content-type"]).toMatch(/javascript/);
  const body = await sw.text();
  expect(body).toContain("push"); // push イベントハンドラを含む
  expect(body).not.toContain("VAPID_PRIVATE_KEY"); // 秘密はバンドルされない

  await createRoom(page, "SW確認");
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready;
    return { scope: r.scope, script: r.active?.scriptURL ?? "" };
  });
  expect(reg.script).toBe(`${new URL(page.url()).origin}/sw.js`);
  expect(reg.scope).toBe(`${new URL(page.url()).origin}/`);
});

test("PIN を6桁未満にすると作成できない（FR-1.1 のクライアント検証）", async ({ page }) => {
  await page.goto("/");
  await page.fill("#c-name", "短いPIN");
  await page.fill("#c-pin", "12345");
  await page.click("#c-create");
  await expect(page.locator(".err:visible")).toContainText("PINは6〜12桁の数字で入力してください");
  await expect(page.locator("#msg-list")).toHaveCount(0);

  // 名前が空でも作れない（FR-3.1）
  await page.fill("#c-pin", "123456");
  await page.fill("#c-name", "   ");
  await page.click("#c-create");
  await expect(page.locator(".err:visible")).toContainText("名前を1〜20文字で入力してください");
});
