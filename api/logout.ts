import { json } from '../server/http.js';
import { clearSessionCookie } from '../server/session.js';

export function POST(): Response {
  return json({ ok: true }, 200, [clearSessionCookie()]);
}
