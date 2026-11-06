import { cacheAccessToken, exchangeCode, idTokenClaims, SCOPES } from '../server/google.js';
import { appUrl, errorMessage, redirect } from '../server/http.js';
import { K, pipeline, redis } from '../server/redis.js';
import { allowedEmail, checkState, clearStateCookie, sessionCookie } from '../server/session.js';

const fail = (msg: string) => redirect(`/?auth_error=${encodeURIComponent(msg)}`, [clearStateCookie()]);

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const error = url.searchParams.get('error');
    if (error) return fail(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google said: ${error}`);
    if (!checkState(req, url.searchParams.get('state'))) return fail('Sign-in expired. Type login to try again.');
    const code = url.searchParams.get('code');
    if (!code) return fail('Google didn’t return a sign-in code.');

    const tokens = await exchangeCode(code, `${appUrl(req)}/api/callback`);
    const claims = idTokenClaims(tokens.id_token);
    const email = (claims.email ?? '').toLowerCase();
    if (!email || claims.email_verified === false || email !== allowedEmail()) {
      return fail(`${email || 'That account'} isn’t allowed to use this Daybound.`);
    }

    const calendarScope = SCOPES[2];
    const grantedCalendar = !tokens.scope || tokens.scope.split(' ').includes(calendarScope);

    if (tokens.refresh_token) {
      await pipeline([
        ['SET', K.refresh, tokens.refresh_token],
        ['DEL', K.err],
      ]);
      if (grantedCalendar) await cacheAccessToken(tokens.access_token, tokens.expires_in);
    } else if (!(await redis<string | null>('GET', K.refresh))) {
      // Google only sends a refresh token on the consent screen. Go back and ask for it.
      return redirect('/api/login?consent=1', [clearStateCookie()]);
    }

    const note = grantedCalendar ? '' : `&auth_error=${encodeURIComponent('Signed in, but Calendar access was not granted. Type login again and allow it to mirror tasks.')}`;
    return redirect(`/?signed_in=1${note}`, [clearStateCookie(), sessionCookie(email)]);
  } catch (e) {
    return fail(errorMessage(e));
  }
}
