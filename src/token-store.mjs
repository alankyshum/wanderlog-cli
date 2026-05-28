import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { TokenCorruptError } from './errors.mjs';

const TOKEN_VERSION = 1;

function expandHome(value) {
  if (!value) return value;
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(2))
    : value;
}

export async function getConfigDir(opts = {}) {
  const dir = path.resolve(expandHome(opts.configDir || process.env.WANDERLOG_CONFIG_DIR || '~/.config/wanderlog'));
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700).catch(() => {});
  return dir;
}

export async function getTokenPath(opts = {}) {
  if (opts.tokenFile) return path.resolve(expandHome(opts.tokenFile));
  return path.join(await getConfigDir(opts), 'token.json');
}

export async function loadToken(opts = {}) {
  const tokenPath = await getTokenPath(opts);
  let text;
  try {
    text = await fs.readFile(tokenPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }

  try {
    const token = JSON.parse(text);
    validateToken(token);
    return token;
  } catch (err) {
    if (err instanceof TokenCorruptError) throw err;
    throw new TokenCorruptError('Stored Wanderlog token is not valid JSON');
  }
}

export async function saveToken(opts = {}, token) {
  validateToken(token);
  const tokenPath = await getTokenPath(opts);
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(tokenPath), 0o700).catch(() => {});

  const tmp = `${tokenPath}.${process.pid}.${Date.now()}.tmp`;
  const json = `${JSON.stringify(token, null, 2)}\n`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  await fs.chmod(tmp, 0o600).catch(() => {});
  await fs.rename(tmp, tokenPath);
  await fs.chmod(tokenPath, 0o600).catch(() => {});
}

export async function deleteToken(opts = {}) {
  await fs.rm(await getTokenPath(opts), { force: true });
}

export async function tokenExists(opts = {}) {
  try {
    await fs.access(await getTokenPath(opts));
    return true;
  } catch {
    return false;
  }
}

export function redactToken(token) {
  if (!token || typeof token !== 'object') return token;
  return {
    ...token,
    cookies: Array.isArray(token.cookies)
      ? token.cookies.map(cookie => ({
          ...cookie,
          value: `[REDACTED:${String(cookie.value || '').length}]`,
        }))
      : token.cookies,
  };
}

function validateToken(token) {
  if (!token || typeof token !== 'object') throw new TokenCorruptError('Token must be an object');
  if (token.version !== TOKEN_VERSION) throw new TokenCorruptError(`Unsupported token version: ${token.version}`);
  if (!token.baseUrl || typeof token.baseUrl !== 'string') throw new TokenCorruptError('Token missing baseUrl');
  if (!token.createdAt || !token.updatedAt) throw new TokenCorruptError('Token missing timestamps');
  if (!Array.isArray(token.cookies) || token.cookies.length === 0) throw new TokenCorruptError('Token missing cookies');

  for (const cookie of token.cookies) {
    if (!cookie || typeof cookie !== 'object') throw new TokenCorruptError('Cookie entry must be an object');
    if (!cookie.name || typeof cookie.name !== 'string') throw new TokenCorruptError('Cookie missing name');
    if (typeof cookie.value !== 'string') throw new TokenCorruptError('Cookie missing value');
    if (!cookie.domain || typeof cookie.domain !== 'string') throw new TokenCorruptError('Cookie missing domain');
    if (!cookie.path || typeof cookie.path !== 'string') throw new TokenCorruptError('Cookie missing path');
  }
}

export { TOKEN_VERSION };
