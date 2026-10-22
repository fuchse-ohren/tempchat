import { createExecutionContext, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index.ts";
import type { Env } from "../../src/worker/env.ts";

describe("smoke", () => {
  it("bundling + D1 binding works", async () => {
    expect(env.DB).toBeDefined();
    const row = await (env as unknown as Env).DB.prepare("SELECT 1 AS one")
      .first<{ one: number }>();
    expect(row?.one).toBe(1);
    const res = await worker.fetch(
      new Request("http://localhost/api/nope"),
      env as unknown as Env,
      createExecutionContext(),
    );
    expect(res.status).toBe(404);
  });
});
