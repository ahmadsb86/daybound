// Minimal Upstash Redis REST client (no dependencies). Works with the env vars the
// Vercel marketplace integration adds (KV_REST_API_*) or Upstash's own (UPSTASH_REDIS_REST_*).

import { ConfigError } from './http.js';

type Arg = string | number;

function config(): { url: string; token: string } {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new ConfigError('The server has no Redis database connected (KV_REST_API_URL / KV_REST_API_TOKEN)');
  return { url: url.replace(/\/+$/, ''), token };
}

export async function redis<T = unknown>(...cmd: Arg[]): Promise<T> {
  const { url, token } = config();
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`Redis ${cmd[0]}: ${body.error ?? res.status}`);
  return body.result as T;
}

export async function pipeline(cmds: Arg[][]): Promise<unknown[]> {
  if (!cmds.length) return [];
  const { url, token } = config();
  const res = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  const body = (await res.json()) as Array<{ result?: unknown; error?: string }>;
  if (!res.ok || !Array.isArray(body)) throw new Error(`Redis pipeline failed (${res.status})`);
  const err = body.find((r) => r.error);
  if (err) throw new Error(`Redis: ${err.error}`);
  return body.map((r) => r.result);
}

/** HGETALL comes back as a flat [field, value, ...] array */
export function pairs(flat: unknown): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (!Array.isArray(flat)) return out;
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([String(flat[i]), String(flat[i + 1])]);
  return out;
}

export const K = {
  tasks: 'db:tasks', // hash: id -> task json
  ts: 'db:tasks:ts', // zset: id scored by server write time (delta sync)
  tz: 'db:tz',
  refresh: 'db:g:refresh',
  access: 'db:g:access',
  cal: 'db:gcal:cal',
  map: 'db:gcal:map', // hash: task id -> {e: event id, h: hash of what was pushed}
  pending: 'db:gcal:pending', // set of task ids waiting to be mirrored
  full: 'db:gcal:full', // date of the last full pass
  err: 'db:gcal:err',
  lock: 'db:gcal:lock',
  pair: (code: string) => `db:pair:${code}`,
};
