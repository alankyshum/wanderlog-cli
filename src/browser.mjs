import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { BrowserUnavailableError } from './errors.mjs';

const execFileAsync = promisify(execFile);

export async function extractCookies(opts = {}) {
  if (opts.cookieString) {
    return { cookies: parseCookieString(opts.cookieString), source: 'manual-import' };
  }

  if (process.env.WANDERLOG_COOKIE) {
    return { cookies: parseCookieString(process.env.WANDERLOG_COOKIE), source: 'env' };
  }

  const browserRun = path.join(os.homedir(), '.claude', 'skills', 'tool--chrome', 'scripts', 'browser-run.js');
  try {
    await fs.access(browserRun);
  } catch {
    throw new BrowserUnavailableError(`Chrome cookie export helper not found at ${browserRun}`);
  }

  let stdout;
  try {
    ({ stdout } = await execFileAsync(process.execPath, [browserRun, 'export-cookies', 'wanderlog.com'], {
      encoding: 'utf8',
      timeout: Number(opts.timeout || 30000),
      maxBuffer: 1024 * 1024,
    }));
  } catch (err) {
    throw new BrowserUnavailableError(`Chrome cookie export failed: ${err.message}`);
  }

  const cookies = normalizeExportedCookies(stdout);
  if (cookies.length === 0) throw new BrowserUnavailableError('No Wanderlog cookies found in browser session');
  return { cookies, source: 'chrome-cdp' };
}

export async function migrateLegacyEnv() {
  const envPath = path.join(process.cwd(), '.claude', 'skills', 'travel', 'wanderlog', 'scripts', '.env');
  let text;
  try {
    text = await fs.readFile(envPath, 'utf8');
  } catch {
    throw new BrowserUnavailableError(`Legacy Wanderlog .env not found at ${envPath}`);
  }
  const line = text.split(/\r?\n/).find(entry => entry.trim().startsWith('WANDERLOG_COOKIE='));
  if (!line) throw new BrowserUnavailableError('Legacy .env does not contain WANDERLOG_COOKIE');
  return line.replace(/^WANDERLOG_COOKIE=/, '').trim().replace(/^['"]|['"]$/g, '');
}

function parseCookieString(cookieString) {
  const cookies = String(cookieString)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      return {
        name: part.slice(0, eq).trim(),
        value: part.slice(eq + 1).trim(),
        domain: '.wanderlog.com',
        path: '/',
      };
    })
    .filter(Boolean);
  if (cookies.length === 0) throw new BrowserUnavailableError('No cookies found in supplied cookie string');
  return cookies;
}

function normalizeExportedCookies(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new BrowserUnavailableError('Chrome cookie export returned invalid JSON');
  }

  const rawCookies = Array.isArray(parsed) ? parsed : parsed.cookies;
  if (!Array.isArray(rawCookies)) throw new BrowserUnavailableError('Chrome cookie export returned unexpected format');

  return rawCookies
    .filter(cookie => String(cookie.domain || '').includes('wanderlog.com'))
    .filter(cookie => cookie.name && typeof cookie.value === 'string')
    .map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain || '.wanderlog.com',
      path: cookie.path || '/',
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
    }));
}
