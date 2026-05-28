import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { login } from '../src/auth.mjs';
import { loadToken } from '../src/token-store.mjs';

test('login saves browser-captured connect.sid even when /api/users/me is unavailable', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-auth-test-'));
  t.after(async () => fs.rm(configDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html>not json</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await login({
    configDir,
    cookieString: 'connect.sid=BROWSERCOOKIE',
    userId: null,
    allowUnknownUserId: true,
  });

  const token = await loadToken({ configDir });
  assert.equal(result.userId, null);
  assert.equal(token.userId, null);
  assert.equal(token.cookies[0].name, 'connect.sid');
  assert.equal(token.cookies[0].value, 'BROWSERCOOKIE');
});

test('login discovers and saves userId when current-user endpoint returns JSON', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-auth-test-'));
  t.after(async () => fs.rm(configDir, { recursive: true, force: true }));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ id: 1144884 }), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await login({
    configDir,
    cookieString: 'connect.sid=BROWSERCOOKIE',
    allowUnknownUserId: true,
  });

  const token = await loadToken({ configDir });
  assert.equal(result.userId, '1144884');
  assert.equal(token.userId, '1144884');
});
