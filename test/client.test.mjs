import test from 'node:test';
import assert from 'node:assert/strict';

import { AuthExpiredError, NetworkError, NotFoundError } from '../src/errors.mjs';
import { createClient } from '../src/client.mjs';

const cookies = [{ name: 'connect.sid', value: 'FAKEVALUE' }];

function installFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => {
    globalThis.fetch = original;
  });
}

test('request includes Cookie header from token cookies', async t => {
  let headers;
  installFetch(t, async (_url, init) => {
    headers = init.headers;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await createClient({ cookies }).get('/api/test');
  assert.equal(headers.Cookie, 'connect.sid=FAKEVALUE');
});

test('401 and 403 responses throw AuthExpiredError with exit code 3', async t => {
  for (const status of [401, 403]) {
    installFetch(t, async () => new Response(JSON.stringify({ error: 'auth' }), { status }));
    await assert.rejects(() => createClient({ cookies }).get('/api/test'), err => {
      assert.ok(err instanceof AuthExpiredError);
      assert.equal(err.exitCode, 3);
      return true;
    });
  }
});

test('404 response throws NotFoundError with exit code 4', async t => {
  installFetch(t, async () => new Response(JSON.stringify({ error: 'missing' }), { status: 404 }));
  await assert.rejects(() => createClient({ cookies }).get('/api/missing'), err => {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.exitCode, 4);
    return true;
  });
});

test('network errors throw NetworkError', async t => {
  installFetch(t, async () => {
    throw new Error('socket closed');
  });
  await assert.rejects(() => createClient({ cookies }).get('/api/test'), NetworkError);
});

test('JSON request body sets Content-Type and stringifies body', async t => {
  let init;
  installFetch(t, async (_url, requestInit) => {
    init = requestInit;
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  await createClient({ cookies }).post('/api/test', { hello: 'world' });
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, JSON.stringify({ hello: 'world' }));
});
