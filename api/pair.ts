import { randomInt } from 'node:crypto';
import { errorMessage, json } from '../server/http.js';
import { K, redis } from '../server/redis.js';
import { allowedEmail, getSession, sessionCookie } from '../server/session.js';

// No 0/O/1/I/L so codes survive being read off a phone screen.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown };
    if (typeof body.code === 'string') {
      const code = body.code.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (code.length !== 8) return json({ error: 'Pairing codes have 8 characters, like ABCD-EFGH.' }, 400);
      const email = await redis<string | null>('GETDEL', K.pair(code));
      if (!email || email !== allowedEmail()) return json({ error: 'That code is wrong or expired. Type pair on a signed-in device for a new one.' }, 400);
      return json({ ok: true }, 200, [sessionCookie(email)]);
    }
    const session = getSession(req);
    if (!session) return json({ error: 'Sign in first.' }, 401);
    let code = '';
    for (let i = 0; i < 8; i++) code += ALPHABET[randomInt(ALPHABET.length)];
    await redis('SET', K.pair(code), session.email, 'EX', 600);
    return json({ code: `${code.slice(0, 4)}-${code.slice(4)}` });
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}
