/** ページ可視中のみ5秒間隔のポーリング（FR-4.1 / 設計 §6.4） */

import { POLL_INTERVAL_MS } from "../shared/constants.ts";

export interface Poller {
  stop(): void;
  /** 手動同期（画像取得後など） */
  sync(): Promise<void>;
}

/**
 * sync は成功で true / 失敗で false を返す。
 * 失敗時は指数バックオフ（最大60秒）。可視でなくなったら停止、可視復帰で即時実行。
 */
export function startPolling(
  sync: () => Promise<boolean>,
  onFatal?: (err: unknown) => void,
): Poller {
  let stopped = false;
  let running = false;
  let fails = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const visible = () => document.visibilityState === "visible";

  const schedule = () => {
    if (stopped) return;
    const delay = fails === 0 ? POLL_INTERVAL_MS : Math.min(60_000, POLL_INTERVAL_MS * 2 ** fails);
    timer = setTimeout(run, delay);
  };

  const run = async (): Promise<void> => {
    if (stopped || running || !visible()) return;
    running = true;
    try {
      const ok = await sync();
      fails = ok ? 0 : fails + 1;
    } catch (e) {
      fails += 1;
      onFatal?.(e);
    } finally {
      running = false;
      schedule();
    }
  };

  const onVisibility = () => {
    if (visible()) {
      if (timer) clearTimeout(timer);
      void run(); // 復帰時即時同期
    }
  };

  document.addEventListener("visibilitychange", onVisibility);
  void run();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    },
    sync: run,
  };
}
