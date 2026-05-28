import { loadToken } from './token-store.mjs';
import { ApiError, AuthExpiredError, AuthRequiredError, NetworkError, NotFoundError, redact } from './errors.mjs';

const DEFAULT_BASE_URL = 'https://wanderlog.com';

export function createClient(opts = {}) {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  let tokenPromise = null;

  async function resolveCookies() {
    if (opts.cookies) return opts.cookies;
    if (!tokenPromise) tokenPromise = loadToken(opts);
    const token = await tokenPromise;
    if (!token) throw new AuthRequiredError();
    return token.cookies;
  }

  async function request(method, requestPath, body) {
    const cookies = await resolveCookies();
    const headers = {
      Accept: 'application/json',
      'User-Agent': 'wlog/0.1.0',
      Cookie: buildCookieHeader(cookies),
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let response;
    try {
      response = await fetch(`${baseUrl}${requestPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new NetworkError(redact(`Network error while contacting Wanderlog: ${err.message}`));
    }

    const text = await response.text();
    const data = parseJson(text, response.status);
    if (response.status === 401 || response.status === 403) throw new AuthExpiredError();
    if (response.status === 404) throw new NotFoundError(`Wanderlog resource not found: ${requestPath}`);
    if (response.status >= 500) throw new ApiError(`Wanderlog API server error (${response.status})`, response.status);
    if (!response.ok) throw new ApiError(redact(`Wanderlog API error (${response.status}): ${text.slice(0, 200)}`), response.status);
    return data;
  }

  return {
    get: request.bind(null, 'GET'),
    post: request.bind(null, 'POST'),
    del: request.bind(null, 'DELETE'),
    put: request.bind(null, 'PUT'),
    baseUrl,
  };
}

export async function validateSession(client, opts = {}) {
  // Wanderlog does not publish an auth API. Try common current-user endpoints
  // first; if they are absent (404) or return non-JSON (HTML), fall through.
  // Auth errors (401/403) are surfaced; anything else means "endpoint not usable".
  for (const userPath of ['/api/users/me', '/api/users/current']) {
    try {
      const data = await client.get(userPath);
      const userId = extractUserId(data);
      if (userId != null) return { userId: String(userId), raw: data };
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      // NotFoundError, ApiError (HTML response, server error), etc. → try next
      continue;
    }
  }

  // No reliable /me endpoint. Probe an authenticated list endpoint with the
  // supplied user id to verify the cookie actually authenticates us.
  if (opts.userId) {
    try {
      await client.get(`/api/tripPlans?userId=${encodeURIComponent(opts.userId)}`);
      return { userId: String(opts.userId), raw: null };
    } catch (err) {
      if (err instanceof AuthExpiredError) throw err;
      throw new Error(`Could not validate session with userId=${opts.userId}: ${err.message}`);
    }
  }
  throw new Error('Could not discover userId; pass --user-id <id> to wlog auth login');
}

export function buildCookieHeader(cookies = []) {
  return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

function parseJson(text, status) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    if (status >= 400) return { error: text.slice(0, 200) };
    throw new ApiError(`Failed to parse Wanderlog response (${status})`, status);
  }
}

function extractUserId(data) {
  if (!data || typeof data !== 'object') return null;
  return data.userId ?? data.id ?? data.user?.id ?? data.data?.id ?? data.data?.userId ?? data.data?.user?.id ?? null;
}
