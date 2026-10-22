/** 受け入れ基準9: ダークモード（FR-7.6） */
import { expect, test, type Page } from "@playwright/test";
import { createRoom } from "./app.ts";

const DARK_BG = "rgb(16, 20, 24)"; // style.css の [data-theme="dark"] --bg: #101418
const LIGHT_BG = "rgb(245, 247, 250)"; // :root --bg: #f5f7fa

const themeState = (page: Page) =>
  page.evaluate(() => ({
    dataTheme: document.documentElement.dataset.theme ?? null,
    stored: localStorage.getItem("theme"),
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }));

/** 設定パネルからテーマを選ぶ（パネルを開いたままなので閉じる） */
async function setTheme(page: Page, value: "auto" | "light" | "dark"): Promise<void> {
  await page.click("#btn-settings");
  await page.selectOption("#set-theme", value);
  await page.locator(".panel .panel-head button").click();
  await expect(page.locator("#btn-settings")).toBeVisible();
}

test("初回は OS の設定に従い、設定は保存されてリロード後も続く", async ({ page }) => {
  await page.goto("/");
  const auto = await themeState(page);
  expect(auto.dataTheme).toBe("light"); // この実行環境は light 既定
  expect(auto.stored).toBeNull(); // 未設定 = auto（OS 追従）
  expect(auto.bodyBg).toBe(LIGHT_BG);

  await createRoom(page, "テーマ検証");

  // 設定からダークへ（FR-7.6）
  await setTheme(page, "dark");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("dark");
  expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("dark");
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(DARK_BG);

  // リロード後もダークのまま（受け入れ基準9）
  await page.reload();
  await expect(page.locator("#composer-text")).toBeVisible({ timeout: 20_000 });
  const after = await themeState(page);
  expect(after.dataTheme).toBe("dark");
  expect(after.stored).toBe("dark");
  expect(after.bodyBg).toBe(DARK_BG);

  // ライトへ戻せる
  await setTheme(page, "light");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");

  // auto にすると OS 設定（この環境では light）へ戻る
  await setTheme(page, "auto");
  await expect
    .poll(() => page.evaluate(() => document.documentElement.dataset.theme))
    .toBe("light");
  expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("auto");
});

test("OS がダーク設定なら初見からダークで表示される（FR-7.6 の自動追従）", async ({
  browser,
}) => {
  const ctx = await browser.newContext({ colorScheme: "dark" });
  const page = await ctx.newPage();
  await page.goto("/");
  const state = await themeState(page);
  expect(state.dataTheme).toBe("dark");
  expect(state.stored).toBeNull();
  expect(state.bodyBg).toBe(DARK_BG);
  await ctx.close();
});

test("テーマ設定はチャット画面以外の全屏にも適用される", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("theme", "dark"));
  await page.reload();
  await expect(page.locator("#create-form")).toBeVisible();
  const state = await themeState(page);
  expect(state.dataTheme).toBe("dark");
  expect(state.bodyBg).toBe(DARK_BG);
});
