import { reconcile } from '../server/gcal.js';
import { errorMessage, json } from '../server/http.js';

// Daily (see vercel.json): rolls overdue events forward in Google Calendar even when no device is open.
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return json({ error: 'unauthorized' }, 401);
  }
  try {
    return json(await reconcile({ full: true }));
  } catch (e) {
    return json({ error: errorMessage(e) }, 500);
  }
}
