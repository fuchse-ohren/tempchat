/** 最小DOMヘルパー（innerHTMLは使わない。設計 §11 XSS対策） */

type Attrs = {
  class?: string;
  on?: Record<string, EventListener>;
  dataset?: Record<string, string>;
  disabled?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
};

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: (Node | string | null | false)[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "on" && typeof v === "object") {
      for (const [ev, fn] of Object.entries(v as Record<string, EventListener>)) {
        el.addEventListener(ev, fn);
      }
    } else if (k === "dataset" && typeof v === "object") {
      for (const [dk, dv] of Object.entries(v as Record<string, string>)) {
        el.dataset[dk] = dv;
      }
    } else if (k === "disabled" || k === "hidden") {
      (el as unknown as Record<string, boolean>)[k] = Boolean(v);
    } else if (v === true) {
      el.setAttribute(k, "");
    } else {
      el.setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

export function clear(el: HTMLElement): void {
  el.replaceChildren();
}
