import { setTimeout as sleep } from 'node:timers/promises';

/** Minimal cookie-session HTTP client for the demo and load-test scripts. */
export function client(base: string) {
  let cookie = '';
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        cookie,
        origin: base,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  return {
    async signIn(email: string, password: string) {
      const res = await fetch(`${base}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(`sign-in as ${email} failed (HTTP ${res.status})`);
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(';')[0])
        .join('; ');
    },
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body: unknown = {}) => call<T>('POST', path, body),
  };
}
export type Client = ReturnType<typeof client>;

/** Poll until `check` returns a value (not undefined/false), or fail after `timeoutMs`. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | false>,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(400);
  }
}

export interface Thread {
  lead: { id: string; state: string; tier: string | null; receivedAt: string };
  messages: {
    direction: 'in' | 'out';
    body: string;
    templateKey: string | null;
    status: string;
    occurredAt: string;
  }[];
}

export const randomPhone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
