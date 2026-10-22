// テーマ初期化（FOUC防止）。localStorage.theme = "auto"|"light"|"dark"
try {
  const t = localStorage.getItem("theme");
  const dark =
    t === "dark" ||
    ((t === null || t === "auto" || t === "") &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch (_e) {
  /* noop */
}
