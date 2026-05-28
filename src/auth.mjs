import { extractCookies, migrateLegacyEnv } from './browser.mjs';
import { createClient, validateSession } from './client.mjs';
import { AuthExpiredError, AuthRequiredError } from './errors.mjs';
import { deleteToken, getTokenPath, loadToken, saveToken } from './token-store.mjs';

const DEFAULT_BASE_URL = 'https://wanderlog.com';

export async function login(opts = {}) {
  const extracted = await extractCookies({ ...opts, cookieString: opts.cookieString || opts.cookie });
  return validateAndSave({ ...opts, cookies: extracted.cookies, source: extracted.source });
}

export async function status(opts = {}) {
  const tokenPath = await getTokenPath(opts);
  let token;
  try {
    token = await loadToken(opts);
  } catch (err) {
    return { authenticated: false, reason: err.name || 'token-corrupt', tokenPath };
  }
  if (!token) return { authenticated: false, reason: 'no-token', tokenPath };

  try {
    const client = createClient({ ...opts, cookies: token.cookies, baseUrl: token.baseUrl });
    const session = await validateSession(client, { ...opts, userId: token.userId || opts.userId });
    token.lastValidatedAt = new Date().toISOString();
    token.updatedAt = token.lastValidatedAt;
    token.userId = session.userId || token.userId;
    await saveToken(opts, token);
    return {
      authenticated: true,
      userId: token.userId,
      lastValidatedAt: token.lastValidatedAt,
      tokenPath,
    };
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      return { authenticated: false, reason: 'expired', tokenPath };
    }
    return { authenticated: false, reason: err.message || 'validation-failed', tokenPath };
  }
}

export async function logout(opts = {}) {
  await deleteToken(opts);
  return { success: true };
}

export async function requireAuth(opts = {}) {
  const token = await loadToken(opts);
  if (!token) throw new AuthRequiredError();
  return token;
}

export async function importCookie(opts = {}) {
  let cookieString = opts.cookieString || opts.cookie;
  let source = 'manual-import';
  if (opts.fromLegacy) {
    cookieString = await migrateLegacyEnv();
    source = 'legacy-env';
  }
  if (!cookieString) throw new Error('Pass --cookie <cookie-string> or --from-legacy');
  const extracted = await extractCookies({ ...opts, cookieString });
  return validateAndSave({ ...opts, cookies: extracted.cookies, source });
}

export async function tokenPath(opts = {}) {
  return getTokenPath(opts);
}

async function validateAndSave(opts) {
  const now = new Date().toISOString();
  const client = createClient({ ...opts, cookies: opts.cookies });
  const session = await validateSession(client, opts);
  const token = {
    version: 1,
    baseUrl: opts.baseUrl || DEFAULT_BASE_URL,
    userId: session.userId || opts.userId,
    createdAt: now,
    updatedAt: now,
    lastValidatedAt: now,
    expiresAt: findEarliestExpiry(opts.cookies),
    source: opts.source,
    cookies: opts.cookies,
  };
  await saveToken(opts, token);
  return { userId: token.userId, source: token.source, expiresAt: token.expiresAt };
}

function findEarliestExpiry(cookies) {
  const expiries = cookies
    .map(cookie => cookie.expires)
    .filter(value => value != null && value !== -1)
    .map(value => (typeof value === 'number' ? new Date(value * 1000).toISOString() : value))
    .sort();
  return expiries[0];
}
