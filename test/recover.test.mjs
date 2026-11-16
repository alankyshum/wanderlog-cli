import test from 'node:test';
import assert from 'node:assert/strict';
import { recover, selectCookie, validateService, validateTarget, loginAction, signInWithGoogle, snapshotRef } from '../src/recover.mjs';

const email = 'fixture@example.test';
const cookie = 'FAKE_COOKIE_VALUE';
const fixture = () => ({ email, userId: '42', cookie });

test('recovery imports in memory, validates identity and fetches the requested trip', async () => {
  const calls = [];
  const result = await recover({}, 'fixture-trip', {
    expectedEmail: email,
    capture: async () => fixture(),
    importCookie: async opts => { calls.push('import'); assert.equal(opts.cookieString, `connect.sid=${cookie}`); assert.equal(opts.userId, '42'); },
    status: async () => { calls.push('status'); return { authenticated: true, userId: '42' }; },
    debugFetch: async (opts, key) => { calls.push('trip'); assert.equal(key, 'fixture-trip'); return { success: true, tripPlan: { key, itinerary: { sections: [] } } }; },
  });
  assert.deepEqual(calls, ['import', 'status', 'trip']);
  assert.deepEqual(result, { authenticated: true, userId: '42', tripKey: 'fixture-trip', tripVerified: true });
  assert.doesNotMatch(JSON.stringify(result), /FAKE_COOKIE_VALUE/);
});

test('signed-out Wanderlog follows Google chooser to the selected account', async () => {
  const states = [
    { origin: 'https://wanderlog.com', path: '/login', googleButton: true },
    { origin: 'https://accounts.google.com', path: '/chooser', chooser: ['other@example.test', email] },
    { origin: 'https://wanderlog.com', path: '/home', email, id: 42 },
  ];
  const clicks = [];
  const snapshots = [{ refs: { e4: { role: 'button', name: 'Log in with Google' } } }, { refs: { e9: { role: 'button', name: email } } }];
  const result = await signInWithGoogle('fixture-session', {
    expectedEmail: email, wait: async () => {},
    browser: async (_, action) => action === 'snapshot' ? snapshots.shift() : ({ result: JSON.stringify(states.shift()) }),
    privateClick: async (_, ref) => { clicks.push(ref); return clicks.length === 1 ? 'uncertain' : 'completed'; },
  });
  assert.equal(result.email, email);
  assert.deepEqual(clicks, ['@e4', '@e9']);
  assert.throws(() => snapshotRef({refs: {e1: {role: 'button', name: 'Log in with Google'}, e2: {role: 'button', name: 'Log in with Google'}}}, 'google', email), /ambiguous/);
  assert.throws(() => snapshotRef({refs: {e1: {role: 'button', name: 'wrong' + email}}}, 'choose', email), /ambiguous/);
});

test('login state refuses mismatch, CAPTCHA and unavailable Google credentials', () => {
  assert.throws(() => loginAction({ origin: 'https://accounts.google.com', chooser: ['other@example.test'] }, email), /account mismatch/);
  assert.throws(() => loginAction({ captcha: true }, email), /CAPTCHA/);
  assert.throws(() => loginAction({ origin: 'https://accounts.google.com', identifier: true }, email), /password and TOTP recovery is not available/);
});

test('one uncertain trusted click is never retried when the page does not advance', async () => {
  let clicks = 0;
  const state = { origin: 'https://wanderlog.com', path: '/login', googleButton: true };
  await assert.rejects(() => signInWithGoogle('fixture-session', {
    expectedEmail: email, wait: async () => {},
    browser: async (_, action) => action === 'snapshot' ? { refs: { e4: { role: 'button', name: 'Log in with Google' } } } : { result: JSON.stringify(state) },
    privateClick: async () => { clicks++; return 'uncertain'; },
  }), /did not complete/);
  assert.equal(clicks, 1);
});

test('client-side home redirect with anonymous bootstrap proceeds to identity verification', async () => {
  const states = [
    { origin: 'https://wanderlog.com', path: '/login', googleButton: true },
    { origin: 'https://wanderlog.com', path: '/home', email: null, id: null },
  ];
  let clicks = 0;
  const result = await signInWithGoogle('fixture-session', {
    expectedEmail: email, wait: async () => {},
    browser: async (_, action) => action === 'snapshot' ? { refs: { e4: { role: 'button', name: 'Log in with Google' } } } : { result: JSON.stringify(states.shift()) },
    privateClick: async () => { clicks++; return 'uncertain'; },
  });
  assert.equal(result.path, '/home');
  assert.equal(result.email, null);
  assert.equal(clicks, 1);
});

test('recovery rejects account mismatch, invalid cookie and untrusted base before import', async () => {
  let imported = false;
  const common = { expectedEmail: email, importCookie: async () => { imported = true; } };
  await assert.rejects(() => recover({}, 'fixture', { ...common, capture: async () => ({ ...fixture(), email: 'other@example.test' }) }), /account mismatch/);
  await assert.rejects(() => recover({}, 'fixture', { ...common, capture: async () => ({ ...fixture(), cookie: 'bad;cookie' }) }), /cookie unavailable/);
  await assert.rejects(() => recover({ baseUrl: 'https://other.example.test' }, 'fixture', { ...common, capture: async () => fixture() }), /only supports/);
  await assert.rejects(() => recover({}, '../bad', { ...common, capture: async () => fixture() }), /Usage/);
  assert.equal(imported, false);
});

test('recovery refuses a failed status or a failed trip fetch', async () => {
  const common = { expectedEmail: email, capture: async () => fixture(), importCookie: async () => {} };
  await assert.rejects(() => recover({}, 'fixture', { ...common, status: async () => ({ authenticated: false }) }), /did not validate/);
  await assert.rejects(() => recover({}, 'fixture', { ...common, status: async () => ({ authenticated: true, userId: '42' }), debugFetch: async () => ({ success: false }) }), /could not verify/);
});

test('browser service, target and cookie selection fail closed', () => {
  const profile = '/fixture/personal-logins';
  const launch = `state = running\npid = 123\n--user-data-dir=${profile}\n--remote-debugging-port=9333\n`;
  assert.doesNotThrow(() => validateService(launch, 'p123\nf1\nn127.0.0.1:9333\n', profile));
  assert.throws(() => validateService(launch, 'p124\nf1\nn127.0.0.1:9333\n', profile), /listener identity/);
  assert.throws(() => validateService(launch, 'p123\nf1\nn*:9333\n', profile), /listener identity/);
  assert.throws(() => validateService(launch.replace(profile, `${profile}-other`), 'p123\nf1\nn127.0.0.1:9333\n', profile), /service identity/);
  const target = { id: 'FIXTURE', type: 'page', url: 'https://wanderlog.com/settings/', webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/FIXTURE' };
  assert.equal(validateTarget([target], 'FIXTURE').hostname, '127.0.0.1');
  assert.throws(() => validateTarget([{ ...target, url: 'https://other.example.test/settings/' }], 'FIXTURE'), /binding failed/);
  assert.throws(() => validateTarget([{ ...target, webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/OTHER' }], 'FIXTURE'), /binding failed/);
  const c = { name: 'connect.sid', domain: '.wanderlog.com', value: cookie, expires: -1 };
  assert.equal(selectCookie([c]), cookie);
  assert.throws(() => selectCookie([c, c]), /unique valid/);
  assert.throws(() => selectCookie([{ ...c, domain: '.example.test' }]), /unique valid/);
});
