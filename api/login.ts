import { authUrl } from '../server/google.js';
import { appUrl, errorMessage, redirect } from '../server/http.js';
import { K, redis } from '../server/redis.js';
import { allowedEmail, newState } from '../server/session.js';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    // Ask Google for a refresh token (consent screen) only when the server doesn't have one yet.
    const haveRefresh = !!(await redis<string | null>('GET', K.refresh));
    const consent = url.searchParams.get('consent') === '1' || !haveRefresh;
    const { state, cookie } = newState();
    const target = authUrl(`${appUrl(req)}/api/callback`, state, consent, allowedEmail());
    return redirect(target, [cookie]);
  } catch (e) {
    return redirect(`/?auth_error=${encodeURIComponent(errorMessage(e))}`);
  }
}
