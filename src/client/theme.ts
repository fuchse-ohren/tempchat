/** テーマ切替（FR-7.6 / 設計 §7.4） */

export type ThemeMode = "auto" | "light" | "dark";

const KEY = "theme";

export function getThemeMode(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

export function applyTheme(): void {
  const mode = getThemeMode();
  const dark =
    mode === "dark" ||
    (mode === "auto" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function setThemeMode(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme();
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (getThemeMode() === "auto") applyTheme();
});
