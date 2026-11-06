export class ConfigError extends Error {}

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new ConfigError(`The server is missing the ${name} environment variable`);
  return v;
}

export function json(data: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(data), { status, headers });
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

/** Public base URL. APP_URL wins so OAuth redirect URIs stay stable. */
export function appUrl(req: Request): string {
  return (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, '');
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
