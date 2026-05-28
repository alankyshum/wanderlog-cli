import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import cookies from './fixtures/cookies.json' with { type: 'json' };
import { TokenCorruptError } from '../src/errors.mjs';
import { TOKEN_VERSION, deleteToken, getConfigDir, getTokenPath, loadToken, redactToken, saveToken } from '../src/token-store.mjs';

function token() {
  return {
    version: TOKEN_VERSION,
    baseUrl: 'https://wanderlog.com',
    userId: 'fixture-user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cookies,
  };
}

async function tmpConfig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-token-store-'));
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('saveToken creates config dir 0700 and token file 0600', async t => {
  const configDir = await tmpConfig(t);
  await saveToken({ configDir }, token());

  const dirMode = (await fs.stat(await getConfigDir({ configDir }))).mode & 0o777;
  const fileMode = (await fs.stat(await getTokenPath({ configDir }))).mode & 0o777;
  assert.equal(dirMode, 0o700);
  assert.equal(fileMode, 0o600);
});

test('loadToken returns parsed token object', async t => {
  const configDir = await tmpConfig(t);
  const expected = token();
  await saveToken({ configDir }, expected);
  assert.deepEqual(await loadToken({ configDir }), expected);
});

test('deleteToken removes token file', async t => {
  const configDir = await tmpConfig(t);
  await saveToken({ configDir }, token());
  await deleteToken({ configDir });
  assert.equal(await loadToken({ configDir }), null);
});

test('redactToken replaces cookie values and leaves other fields intact', () => {
  const redacted = redactToken(token());
  assert.equal(redacted.baseUrl, 'https://wanderlog.com');
  assert.equal(redacted.cookies[0].name, 'connect.sid');
  assert.equal(redacted.cookies[0].domain, 'wanderlog.com');
  assert.equal(redacted.cookies[0].value, '[REDACTED:9]');
});

test('token schema version mismatch throws TokenCorruptError', async t => {
  const configDir = await tmpConfig(t);
  const tokenPath = await getTokenPath({ configDir });
  await fs.mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenPath, JSON.stringify({ ...token(), version: 999 }), { mode: 0o600 });
  await assert.rejects(() => loadToken({ configDir }), TokenCorruptError);
});
