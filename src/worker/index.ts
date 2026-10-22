/** Worker エントリ（fetch / scheduled） */

import type { Env } from "./env.ts";
import { handleApi } from "./routes.ts";
import { purgeExpired } from "./scheduled.ts";
import { ApiError, json } from "./util.ts";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(req, env, ctx, url);
      } catch (e) {
        if (e instanceof ApiError) return json({ error: e.code }, e.status);
        // 平文・鍵・個人情報をログへ出さないため種別のみ（NFR-8）
        console.error(
          "api-error:",
          e instanceof Error ? (e.constructor?.name ?? "Error") : typeof e,
        );
        return json({ error: "internal" }, 500);
      }
    }
    return json({ error: "not_found" }, 404);
  },

  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(purgeExpired(env));
  },
};
