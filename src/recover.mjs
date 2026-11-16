import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { AuthRequiredError, BrowserUnavailableError, UsageError } from './errors.mjs';
import { importCookie, status } from './auth.mjs';
import { debugFetch } from './trips.mjs';

const execFile = promisify(execFileCallback);
const ORIGIN = 'https://wanderlog.com';
const EMAIL = 'alan200994@gmail.com';
const CDP = 'http://127.0.0.1:9333';
const SETTINGS = `${ORIGIN}/settings/`;
const SAFE_ENV = () => Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'USER', 'LOGNAME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));

export async function recover(opts = {}, tripKey, dependencies = {}) {
  if (!tripKey || !/^[A-Za-z0-9_-]{1,128}$/.test(tripKey)) throw new UsageError('Usage: wlog auth recover <tripKey>');
  if (opts.baseUrl && opts.baseUrl.replace(/\/$/, '') !== ORIGIN) throw new UsageError('Recovery only supports wanderlog.com');
  const capture = dependencies.capture || capturePersonalSession;
  const importer = dependencies.importCookie || importCookie;
  const getStatus = dependencies.status || status;
  const getTrip = dependencies.debugFetch || debugFetch;
  const captured = await capture(opts);
  if (captured?.email !== (dependencies.expectedEmail || EMAIL) || !/^\d+$/.test(String(captured?.userId || ''))) throw new AuthRequiredError('Wanderlog account mismatch or identity unavailable');
  if (typeof captured.cookie !== 'string' || !captured.cookie || /[;\r\n]/.test(captured.cookie)) throw new AuthRequiredError('Wanderlog session cookie unavailable');
  await importer({ ...opts, cookieString: `connect.sid=${captured.cookie}`, userId: String(captured.userId), baseUrl: ORIGIN });
  const checked = await getStatus({ ...opts, baseUrl: ORIGIN });
  if (!checked.authenticated || String(checked.userId) !== String(captured.userId)) throw new AuthRequiredError('Recovered session did not validate');
  const fetched = await getTrip({ ...opts, baseUrl: ORIGIN }, tripKey);
  if (fetched?.success !== true || fetched?.tripPlan?.key !== tripKey || !Array.isArray(fetched.tripPlan?.itinerary?.sections)) {
    throw new AuthRequiredError('Recovered session could not verify the requested trip');
  }
  return { authenticated: true, userId: checked.userId, tripKey, tripVerified: true };
}

async function command(program, args) {
  try {
    const result = await execFile(program, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024, env: SAFE_ENV() });
    return result.stdout;
  } catch {
    throw new BrowserUnavailableError(`Recovery helper failed: ${program}`);
  }
}

async function verifyBrowserService() {
  const service = `gui/${process.getuid()}/com.user.agent-browser-chrome`;
  let endpoint;
  try { endpoint = await fetch(`${CDP}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(3000) }); } catch { /* start the existing service below */ }
  if (!endpoint?.ok) {
    await command('launchctl', ['kickstart', service]);
    try { endpoint = await fetch(`${CDP}/json/version`, { redirect: 'error', signal: AbortSignal.timeout(3000) }); } catch { throw new BrowserUnavailableError('Personal browser CDP unavailable'); }
  }
  if (!endpoint.ok) throw new BrowserUnavailableError('Personal browser CDP unavailable');
  const launch = await command('launchctl', ['print', service]);
  const profile = `${process.env.HOME}/.agent-browser/profiles/personal-logins`;
  const listener = await command('lsof', ['-nP', '-a', '-iTCP:9333', '-sTCP:LISTEN', '-Fpn']);
  validateService(launch, listener, profile);
}

export function validateService(launch, listener, profile) {
  const pid = launch.match(/^\s*pid = (\d+)\s*$/m)?.[1];
  const lines = launch.split('\n').map(line => line.trim());
  if (!pid || !/^\s*state = running\s*$/m.test(launch) || !lines.includes(`--user-data-dir=${profile}`) || !lines.includes('--remote-debugging-port=9333')) {
    throw new BrowserUnavailableError('Personal browser service identity could not be verified');
  }
  const pids = [...listener.matchAll(/^p(\d+)$/gm)].map(x => x[1]);
  const names = [...listener.matchAll(/^n(.+)$/gm)].map(x => x[1]);
  if (pids.length !== 1 || pids[0] !== pid || names.length !== 1 || names[0] !== '127.0.0.1:9333') {
    throw new BrowserUnavailableError('Personal browser listener identity could not be verified');
  }
}

async function browser(session, ...args) {
  const output = await command('agent-browser', ['--session', session, '--cdp', '9333', '--pin-tab', ...args, '--json']);
  let value;
  try { value = JSON.parse(output); } catch { throw new BrowserUnavailableError('Invalid browser helper response'); }
  if (value.success !== true || !value.data) throw new BrowserUnavailableError('Browser helper reported failure');
  return value.data;
}

const READ_LOGIN_STATE = `JSON.stringify((()=>{const u=window.__MOBX_STATE__?.auth?.user;const text=document.body?.innerText||'';const visible=e=>e.getClientRects().length>0;return {origin:location.origin,path:location.pathname,email:u?.email||null,id:u?.id||null,googleButton:[...document.querySelectorAll('button')].some(e=>visible(e)&&e.innerText.trim()==='Log in with Google'),chooser:[...document.querySelectorAll('[data-identifier]')].filter(visible).map(e=>e.getAttribute('data-identifier')),identifier:!!document.querySelector('input[type=email]'),password:!!document.querySelector('input[type=password]'),captcha:/captcha|unusual traffic/i.test(text),pushOrSms:/check your phone|tap yes|text message|sms code/i.test(text)}})())`;
async function privateClick(session, ref) {
  const helper = `${process.env.HOME}/.claude/skills/agent-browser/scripts/agent_browser.py`;
  if (!/^@e\d+$/.test(ref)) throw new BrowserUnavailableError('Invalid browser snapshot reference');
  try {
    const output = await execFile('python3', [helper, 'private', '--session', session, '--cdp', '9333', '--', 'click', ref], { env: SAFE_ENV(), timeout: 60000, maxBuffer: 100000 });
    if (JSON.parse(output.stdout)?.status !== 'completed') throw new BrowserUnavailableError('Private login guard returned invalid output');
    return 'completed';
  } catch (error) {
    let result;
    try { result = JSON.parse(error.stdout || ''); } catch { throw new BrowserUnavailableError('Private login guard unavailable'); }
    if (result.error === 'private_browser_command_failed') return 'uncertain';
    throw new BrowserUnavailableError('Private login guard failed; no retry');
  }
}

export function snapshotRef(snapshot, action, email) {
  if (!['google', 'choose'].includes(action) || typeof email !== 'string' || !email) throw new BrowserUnavailableError('Invalid login action');
  const escaped = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactEmail = new RegExp(`(^|[^A-Za-z0-9._%+\\-])${escaped}(?=$|[^A-Za-z0-9._%+\\-])`, 'i');
  const refs = snapshot?.refs || {};
  const matches = Object.entries(refs).filter(([id, value]) => /^e\d+$/.test(id) && value &&
    (action === 'google' ? value.role === 'button' && value.name === 'Log in with Google'
      : ['button', 'link'].includes(value.role) && typeof value.name === 'string' && exactEmail.test(value.name)));
  if (matches.length !== 1) throw new BrowserUnavailableError('Login action is missing or ambiguous in browser snapshot');
  return `@${matches[0][0]}`;
}

export function loginAction(state, expectedEmail) {
  if (state.captcha) throw new AuthRequiredError('CAPTCHA requires user action');
  if (state.email && state.email.toLowerCase() !== expectedEmail.toLowerCase()) throw new AuthRequiredError('Wanderlog account mismatch');
  if (state.email && state.id && state.origin === ORIGIN) return 'signed-in';
  // The client-side redirect to /home may retain the anonymous bootstrap
  // store even when the profile UI is signed in. Reopen Settings and verify.
  if (state.origin === ORIGIN && /^\/(?:home|settings)\/?$/.test(state.path)) return 'verify';
  if (state.origin === ORIGIN && /^\/login\/?$/.test(state.path) && state.googleButton) return 'google';
  if (state.origin === 'https://accounts.google.com' && Array.isArray(state.chooser) && state.chooser.length) {
    if (state.chooser.filter(x => typeof x === 'string' && x.toLowerCase() === expectedEmail.toLowerCase()).length !== 1) throw new AuthRequiredError('Google account mismatch');
    return 'choose';
  }
  if (state.origin === 'https://accounts.google.com' && (state.identifier || state.password)) throw new AuthRequiredError('Google signed out: password and TOTP recovery is not available; inspect the designated 1Password item and guarded bridge');
  if (state.pushOrSms) throw new AuthRequiredError('Google push or SMS challenge requires user action');
  return 'wait';
}

export async function signInWithGoogle(session, deps = {}) {
  const browserCall = deps.browser || browser;
  const guard = deps.privateClick || privateClick;
  const wait = deps.wait || (async () => new Promise(resolve => setTimeout(resolve, 750)));
  const expectedEmail = deps.expectedEmail || EMAIL;
  let clicked = false, chosen = false;
  let previous;
  // The login dialog appears before its React/Google click handler is ready.
  // Let the mounted page settle before dispatching one trusted click.
  for (let i = 0; i < 4; i++) await wait();
  for (let attempt = 0; attempt < 40; attempt++) {
    const data = await browserCall(session, 'eval', READ_LOGIN_STATE);
    let state;
    try { state = JSON.parse(data.result); } catch { throw new BrowserUnavailableError('Login state response invalid'); }
    const action = loginAction(state, expectedEmail);
    const phase = action;
    if (phase !== previous) deps.onStep?.(phase);
    previous = phase;
    if (action === 'signed-in' || action === 'verify') return state;
    if (action === 'google' && !clicked) {
      const snap = await browserCall(session, 'snapshot', '-i');
      clicked = true;
      const outcome = await guard(session, snapshotRef(snap, action, expectedEmail));
      deps.onStep?.(`guarded Google click: ${outcome}`);
    } else if (action === 'choose' && !chosen) {
      const snap = await browserCall(session, 'snapshot', '-i');
      chosen = true;
      const outcome = await guard(session, snapshotRef(snap, action, expectedEmail));
      deps.onStep?.(`guarded account click: ${outcome}`);
    }
    await wait();
  }
  throw new AuthRequiredError('Google sign-in did not complete; inspect the owned browser tab');
}

async function capturePersonalSession(opts = {}) {
  await verifyBrowserService();
  const session = `wanderlog-recover-${randomBytes(16).toString('hex')}`;
  let opened = false;
  let leaveOpen = false;
  try {
    const page = await browser(session, 'open', SETTINGS);
    opened = true;
    if (page.lifecycle?.launched !== false || !/^[A-F0-9]{32}$/i.test(page.targetId || '')) throw new BrowserUnavailableError('Pinned browser target was not verified');
    let identity;
    for (let attempt = 0; attempt < 4; attempt++) {
      const evaluated = await browser(session, 'eval', 'JSON.stringify({email:window.__MOBX_STATE__?.auth?.user?.email||null,id:window.__MOBX_STATE__?.auth?.user?.id||null})');
      let evaluatedUrl;
      try { evaluatedUrl = new URL(evaluated.origin); } catch { throw new BrowserUnavailableError('Browser identity origin invalid'); }
      if (evaluatedUrl.origin !== ORIGIN) throw new BrowserUnavailableError('Browser identity origin mismatch');
      try { identity = JSON.parse(evaluated.result); } catch { throw new BrowserUnavailableError('Browser identity response invalid'); }
      if (identity.email && identity.id) break;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 750));
    }
    if (!identity?.email || !identity?.id) {
      await browser(session, 'open', `${ORIGIN}/login`);
      await signInWithGoogle(session, { onStep: opts.verbose ? text => console.error(`auth recover: ${text}`) : undefined });
      await browser(session, 'open', SETTINGS);
      const evaluated = await browser(session, 'eval', 'JSON.stringify({email:window.__MOBX_STATE__?.auth?.user?.email||null,id:window.__MOBX_STATE__?.auth?.user?.id||null})');
      try { identity = JSON.parse(evaluated.result); } catch { throw new BrowserUnavailableError('Browser identity response invalid'); }
    }
    if (identity.email !== EMAIL) throw new AuthRequiredError('Personal browser is signed in to a different Wanderlog account');
    const cookie = await cookieForTarget(page.targetId);
    return { email: identity.email, userId: String(identity.id), cookie };
  } catch (error) {
    if (error instanceof AuthRequiredError && /CAPTCHA|push|SMS|account mismatch|sign-in did not complete|password and TOTP recovery is not available/i.test(error.message)) {
      leaveOpen = true;
      error.message += ` (browser session ${session})`;
    }
    throw error;
  } finally {
    if (opened && !leaveOpen) {
      try { await browser(session, 'tab', 'close'); }
      finally { await browser(session, 'close'); }
    }
  }
}

async function cookieForTarget(targetId) {
  let targets;
  try {
    const response = await fetch(`${CDP}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error();
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw new Error();
    targets = JSON.parse(text);
  } catch { throw new BrowserUnavailableError('Personal browser targets unavailable'); }
  const wsUrl = validateTarget(targets, targetId);
  const cookies = await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); reject(new BrowserUnavailableError('Cookie capture timed out')); }, 10000);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Network.getCookies', params: { urls: [`${ORIGIN}/`] } }));
    ws.onerror = () => { clearTimeout(timer); ws.close(); reject(new BrowserUnavailableError('Cookie capture connection failed')); };
    ws.onmessage = event => {
      try {
        const reply = JSON.parse(event.data);
        if (reply.id !== 1) return;
        clearTimeout(timer); ws.close();
        if (!Array.isArray(reply.result?.cookies)) return reject(new BrowserUnavailableError('Cookie capture failed'));
        resolve(reply.result.cookies);
      } catch { clearTimeout(timer); ws.close(); reject(new BrowserUnavailableError('Cookie capture response invalid')); }
    };
  });
  return selectCookie(cookies);
}

export function validateTarget(targets, targetId) {
  const matches = Array.isArray(targets) ? targets.filter(t => t.id === targetId && t.type === 'page') : [];
  if (matches.length !== 1) throw new BrowserUnavailableError('Pinned browser target unavailable');
  let pageUrl, wsUrl;
  try { pageUrl = new URL(matches[0].url); wsUrl = new URL(matches[0].webSocketDebuggerUrl); } catch { throw new BrowserUnavailableError('Pinned browser target invalid'); }
  if (pageUrl.origin !== ORIGIN || !/^\/settings\/?$/.test(pageUrl.pathname) || wsUrl.protocol !== 'ws:' || wsUrl.hostname !== '127.0.0.1' || wsUrl.port !== '9333' || wsUrl.pathname !== `/devtools/page/${targetId}` || wsUrl.search || wsUrl.hash || wsUrl.username || wsUrl.password) {
    throw new BrowserUnavailableError('Pinned browser target binding failed');
  }
  return wsUrl;
}

export function selectCookie(cookies) {
  const matchesCookie = cookies.filter(c => c.name === 'connect.sid' && ['wanderlog.com', '.wanderlog.com'].includes(c.domain) && (c.expires === -1 || c.expires > Date.now() / 1000));
  if (matchesCookie.length !== 1) throw new AuthRequiredError('No unique valid Wanderlog cookie');
  return matchesCookie[0].value;
}
