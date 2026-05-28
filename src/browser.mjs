import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn as spawnProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { BrowserUnavailableError } from './errors.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://wanderlog.com';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SETTLE_MS = 1500;
const CONNECT_SID = 'connect.sid';

const MAC_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const LINUX_BROWSER_COMMANDS = [
  'google-chrome',
  'chrome',
  'chromium',
  'chromium-browser',
  'microsoft-edge',
];

const WINDOWS_BROWSER_PATHS = [
  ['PROGRAMFILES', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['PROGRAMFILES(X86)', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['LOCALAPPDATA', 'Google', 'Chrome', 'Application', 'chrome.exe'],
  ['PROGRAMFILES', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ['PROGRAMFILES(X86)', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ['LOCALAPPDATA', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
  ['PROGRAMFILES', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['PROGRAMFILES(X86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
  ['LOCALAPPDATA', 'Microsoft', 'Edge', 'Application', 'msedge.exe'],
];

export async function extractCookies(opts = {}) {
  if (opts.cookieString) {
    return { cookies: parseCookieString(opts.cookieString), source: 'manual-import' };
  }

  if (process.env.WANDERLOG_COOKIE) {
    return { cookies: parseCookieString(process.env.WANDERLOG_COOKIE), source: 'env' };
  }

  const captured = await captureCookieViaBrowser(opts);
  return { cookies: [captured.cookie], source: 'browser-cdp', userId: captured.userId ?? null };
}

export async function captureCookieViaBrowser(opts = {}) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl || DEFAULT_BASE_URL);
  const origin = new URL(baseUrl).origin;
  const loginUrl = `${origin}/login`;
  const timeoutMs = parseTimeout(opts.timeout, DEFAULT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const log = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};

  let tempDir = opts.userDataDir;
  let createdTempDir = false;
  let browserProcess = null;
  let connection = null;

  try {
    const chromePath = opts.chromePath || await locateChromeBinary(opts);
    const port = Number(opts.port || await findFreePort(opts.startPort || 9222));
    if (!tempDir) {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-auth-'));
      createdTempDir = true;
    }

    log(`Opening Chrome to ${loginUrl} ...`);
    browserProcess = launchChrome(chromePath, {
      port,
      tempDir,
      loginUrl,
      spawn: opts.spawn,
    });

    const target = await waitForPageTarget({
      port,
      baseUrl: origin,
      fetchImpl: opts.fetchImpl || globalThis.fetch,
      deadline,
      verbose: opts.verbose,
      log,
    });

    connection = await CdpConnection.open(target.webSocketDebuggerUrl, {
      WebSocketImpl: opts.WebSocketImpl || globalThis.WebSocket,
      deadline,
    });

    await connection.send('Page.enable');
    await connection.send('Network.enable');

    log(`Waiting for you to sign in (timeout: ${formatDuration(timeoutMs)}) ...`);
    await waitForSignIn(connection, { baseUrl: origin, deadline, timeoutMs, verbose: opts.verbose, log });
    log('✓ Detected sign-in');

    const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS;
    if (settleMs > 0) await sleep(Math.min(settleMs, remainingMs(deadline)));

    const cookie = await getConnectSidCookie(connection, origin);
    log(`✓ Cookie captured (${CONNECT_SID}, expires ${formatCookieExpiry(cookie.expires)})`);
    return {
      cookieValue: cookie.value,
      expires: cookie.expires,
      cookie,
      userId: null,
    };
  } finally {
    await closeChrome({ connection, browserProcess, timeoutMs: 2000 });
    if (createdTempDir && tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

export async function locateChromeBinary(opts = {}) {
  if (opts.chromePath) return opts.chromePath;

  if (process.platform === 'darwin') {
    for (const candidate of MAC_BROWSER_PATHS) {
      if (await exists(candidate)) return candidate;
    }
  } else if (process.platform === 'linux') {
    for (const command of LINUX_BROWSER_COMMANDS) {
      try {
        const { stdout } = await execFileAsync('which', [command], { encoding: 'utf8' });
        const candidate = stdout.trim().split(/\r?\n/)[0];
        if (candidate) return candidate;
      } catch {
        // Try the next browser command.
      }
    }
  } else if (process.platform === 'win32') {
    for (const parts of WINDOWS_BROWSER_PATHS) {
      const [envKey, ...segments] = parts;
      const root = process.env[envKey];
      if (!root) continue;
      const candidate = path.join(root, ...segments);
      if (await exists(candidate)) return candidate;
    }
  }

  throw new BrowserUnavailableError(
    'No compatible browser found. Install Google Chrome, Chromium, Brave, or Microsoft Edge, then run `wlog auth login` again.',
  );
}

export async function findFreePort(startPort = 9222, attempts = 100) {
  for (let port = Number(startPort); port < Number(startPort) + attempts; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new BrowserUnavailableError(`Could not find a free local CDP port starting at ${startPort}`);
}

export function parseTimeout(value, defaultMs = DEFAULT_TIMEOUT_MS) {
  if (value == null || value === '') return defaultMs;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new BrowserUnavailableError('Timeout must be a positive duration');
    return Math.trunc(value);
  }

  const text = String(value).trim().toLowerCase();
  const match = text.match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/);
  if (!match) throw new BrowserUnavailableError('Timeout must be a duration like 300000, 30s, or 10m');
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) throw new BrowserUnavailableError('Timeout must be a positive duration');
  const unit = match[2] || 'ms';
  const multiplier = unit === 'm' ? 60_000 : unit === 's' ? 1000 : 1;
  return Math.trunc(amount * multiplier);
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

function launchChrome(chromePath, { port, tempDir, loginUrl, spawn }) {
  const args = [
    `--user-data-dir=${tempDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-allow-origins=http://localhost:${port}`,
    loginUrl,
  ];

  const spawnFn = spawn || spawnProcess;
  const child = spawnFn(chromePath, args, { detached: false, stdio: 'ignore' });
  if (!child || typeof child !== 'object') return null;
  child.once?.('error', () => {});
  return child;
}

async function waitForPageTarget({ port, baseUrl, fetchImpl, deadline, verbose, log }) {
  if (typeof fetchImpl !== 'function') throw new BrowserUnavailableError('Built-in fetch is not available; Node 22+ is required');

  const endpoint = `http://localhost:${port}/json`;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(endpoint);
      if (response?.ok) {
        const targets = await response.json();
        const pages = Array.isArray(targets) ? targets.filter(target => target.type === 'page') : [];
        const target = pages.find(page => String(page.url || '').startsWith(baseUrl)) || pages[0];
        if (target?.webSocketDebuggerUrl) return target;
      }
    } catch (err) {
      lastError = err;
      if (verbose) log(`CDP discovery retry: ${err.message}`);
    }
    await sleep(250);
  }

  throw new BrowserUnavailableError(
    `Could not connect to Chrome DevTools on ${endpoint}${lastError ? `: ${lastError.message}` : ''}`,
  );
}

async function waitForSignIn(connection, { baseUrl, deadline, timeoutMs, verbose, log }) {
  let resolveSignedIn;
  const signedIn = new Promise(resolve => {
    resolveSignedIn = resolve;
  });

  const checkUrl = url => {
    if (isSignedInUrl(url, baseUrl)) {
      resolveSignedIn(url);
      return true;
    }
    return false;
  };

  const unsubscribe = connection.on('Page.frameNavigated', params => {
    const frame = params?.frame;
    if (!frame || frame.parentId !== undefined) return;
    if (verbose) log(`CDP frameNavigated: ${frame.url}`);
    checkUrl(frame.url);
  });

  try {
    try {
      const frameTree = await connection.send('Page.getFrameTree');
      const currentUrl = frameTree?.frameTree?.frame?.url;
      if (verbose && currentUrl) log(`CDP current frame: ${currentUrl}`);
      if (checkUrl(currentUrl)) return;
    } catch (err) {
      if (verbose) log(`CDP Page.getFrameTree unavailable: ${err.message}`);
    }

    await Promise.race([
      signedIn,
      timeoutPromise(deadline, `Sign-in not completed within ${formatDuration(timeoutMs)}. Run again or use \`wlog auth login --timeout 10m\`.`),
    ]);
  } finally {
    unsubscribe();
  }
}

async function getConnectSidCookie(connection, baseUrl) {
  const response = await connection.send('Network.getCookies', { urls: [baseUrl] });
  const cookies = Array.isArray(response?.cookies) ? response.cookies : [];
  const cookie = cookies.find(entry => entry?.name === CONNECT_SID && typeof entry.value === 'string' && entry.value.length > 0);
  if (!cookie) throw new BrowserUnavailableError('No connect.sid cookie found after sign-in. Run `wlog auth login` again.');
  return normalizeCookie(cookie);
}

async function closeChrome({ connection, browserProcess, timeoutMs }) {
  if (connection) {
    try {
      await connection.send('Browser.close', undefined, { timeoutMs: 1000 });
    } catch {
      // The browser may already be closing.
    }
    connection.close();
  }

  if (!browserProcess || browserProcess.exitCode !== null || browserProcess.signalCode) return;

  const exited = once(browserProcess, 'exit').then(() => true).catch(() => true);
  const timedOut = sleep(timeoutMs).then(() => false);
  if (await Promise.race([exited, timedOut])) return;

  try {
    browserProcess.kill('SIGTERM');
  } catch {
    // Ignore process teardown races.
  }
}

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.handleMessage = this.handleMessage.bind(this);
    ws.addEventListener('message', this.handleMessage);
  }

  static async open(url, { WebSocketImpl, deadline }) {
    if (typeof WebSocketImpl !== 'function') throw new BrowserUnavailableError('Built-in WebSocket is not available; Node 22+ is required');
    const ws = new WebSocketImpl(url);
    await waitForWebSocketOpen(ws, deadline);
    return new CdpConnection(ws);
  }

  send(method, params, opts = {}) {
    const id = this.nextId++;
    const payload = params === undefined ? { id, method } : { id, method, params };
    const timeoutMs = opts.timeoutMs || 10_000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrowserUnavailableError(`Timed out waiting for CDP response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) || new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    try {
      this.ws.removeEventListener?.('message', this.handleMessage);
      this.ws.close?.();
    } catch {
      // Ignore close races.
    }
  }

  async handleMessage(event) {
    const text = await webSocketDataToText(event.data);
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }

    if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new BrowserUnavailableError(`CDP ${pending.method} failed: ${message.error.message || JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result || {});
      }
      return;
    }

    const listeners = this.listeners.get(message.method);
    if (!listeners) return;
    for (const listener of listeners) listener(message.params || {});
  }
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

function normalizeCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || '.wanderlog.com',
    path: cookie.path || '/',
    expires: cookie.expires,
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
    sameSite: cookie.sameSite,
  };
}

function isSignedInUrl(url, baseUrl) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith(`${baseUrl}/`) && !url.includes('/login');
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function formatDuration(ms) {
  if (ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms % 1000 === 0) return `${ms / 1000} sec`;
  return `${ms} ms`;
}

function formatCookieExpiry(expires) {
  if (expires == null || expires === -1) return 'session';
  if (typeof expires === 'number') return new Date(expires * 1000).toISOString().slice(0, 10);
  return String(expires).slice(0, 10);
}

async function exists(candidate) {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function canListen(port) {
  const server = net.createServer();
  server.unref();
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve)).catch(() => {});
  }
}

function remainingMs(deadline) {
  return Math.max(0, deadline - Date.now());
}

function timeoutPromise(deadline, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new BrowserUnavailableError(message)), remainingMs(deadline));
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

function waitForWebSocketOpen(ws, deadline) {
  if (ws.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new BrowserUnavailableError('Timed out connecting to Chrome DevTools WebSocket'));
    }, remainingMs(deadline));
    const cleanup = () => {
      clearTimeout(timer);
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new BrowserUnavailableError('Could not connect to Chrome DevTools WebSocket'));
    };
    ws.addEventListener('open', onOpen, { once: true });
    ws.addEventListener('error', onError, { once: true });
  });
}

async function webSocketDataToText(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  if (data && typeof data.text === 'function') return data.text();
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return '';
}
