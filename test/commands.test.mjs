import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLIError, ConfirmRequiredError } from '../src/errors.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { TOKEN_VERSION, saveToken } from '../src/token-store.mjs';

async function tmpConfigWithToken(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-commands-'));
  t.after(async () => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, {
    version: TOKEN_VERSION,
    baseUrl: 'https://wanderlog.com',
    userId: 'fixture-user',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cookies: [{ name: 'connect.sid', value: 'FAKEVALUE', domain: 'wanderlog.com', path: '/' }],
  });
  return configDir;
}

test('unknown command throws CLIError with exit code 2', async () => {
  const dispatcher = createCommandDispatcher({});
  await assert.rejects(() => dispatcher.execute('unknown', null, []), err => {
    assert.ok(err instanceof CLIError);
    assert.equal(err.exitCode, 2);
    return true;
  });
});

test('help mode resolves to command-specific handler text without service calls', async () => {
  const dispatcher = createCommandDispatcher({ help: true });
  assert.match((await dispatcher.execute('auth', null, [])).data, /wlog auth/);
  assert.match((await dispatcher.execute('trips', null, [])).data, /wlog trips/);
  assert.match((await dispatcher.execute('sections', null, [])).data, /wlog sections/);
  assert.match((await dispatcher.execute('places', null, [])).data, /wlog places/);
  assert.match((await dispatcher.execute('calendar', null, [])).data, /wlog calendar/);
});

test('trips delete requires --confirm before network mutation', async t => {
  const configDir = await tmpConfigWithToken(t);
  await assert.rejects(
    () => createCommandDispatcher({ configDir }).execute('trips', 'delete', ['TESTTRIP1']),
    err => err instanceof ConfirmRequiredError && err.exitCode === 5,
  );
});

test('sections delete requires --confirm before fetch/mutation', async t => {
  const configDir = await tmpConfigWithToken(t);
  await assert.rejects(
    () => createCommandDispatcher({ configDir }).execute('sections', 'delete', ['TESTTRIP1', 'sec-day-1']),
    err => err instanceof ConfirmRequiredError && err.exitCode === 5,
  );
});

test('places delete requires --confirm before fetch/mutation', async t => {
  const configDir = await tmpConfigWithToken(t);
  await assert.rejects(
    () => createCommandDispatcher({ configDir }).execute('places', 'delete', ['TESTTRIP1', 'sec-day-1', '0']),
    err => err instanceof ConfirmRequiredError && err.exitCode === 5,
  );
});
