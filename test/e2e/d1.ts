/** ローカル D1 への CLI クエリ（handoff §3: wrangler d1 execute --local / dev と同じ .wrangler/state） */
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const HOME = resolve(process.cwd(), ".home");

const env: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: process.env.HOME ?? HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? resolve(HOME, ".config"),
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? resolve(HOME, ".cache"),
};

/** 1コマンド1ステートメント（handoff §3 の実測制約） */
export async function d1<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const { stdout } = await run(
    "npx",
    ["wrangler", "d1", "execute", "tempchat", "--local", "--json", "--command", sql],
    { env, maxBuffer: 64 * 1024 * 1024, timeout: 120_000 },
  );
  const start = stdout.indexOf("[");
  const parsed = JSON.parse(stdout.slice(start)) as {
    results: T[];
    success: boolean;
  }[];
  const first = parsed[0];
  if (!first || first.success !== true) {
    throw new Error(`d1 execute failed: ${stdout.slice(0, 400)}`);
  }
  return first.results;
}

/** D1 全内容をテキスト化して返す（平文混入の検査用。BLOB は hex 化） */
export async function d1DumpText(): Promise<string> {
  const [row] = await d1<{ rooms: string | null; messages: string | null; blobs: string | null; subs: string | null }>(
    `SELECT
       (SELECT group_concat(id || '|' || hex(key_hash) || '|' || created_at || '|' || COALESCE(last_msg_at,-1), '~') FROM rooms) AS rooms,
       (SELECT group_concat(id || '|' || room_id || '|' || ts || '|' || kind || '|' || COALESCE(hex(ct),'-'), '~') FROM messages) AS messages,
       (SELECT group_concat(msg_id || '|' || seq || '|' || hex(chunk), '~') FROM message_blobs) AS blobs,
       (SELECT group_concat(endpoint || '|' || room_id || '|' || p256dh || '|' || auth, '~') FROM push_subs) AS subs`,
  );
  return [`rooms=${row?.rooms ?? ""}`, `messages=${row?.messages ?? ""}`, `blobs=${row?.blobs ?? ""}`, `subs=${row?.subs ?? ""}`].join("\n");
}
