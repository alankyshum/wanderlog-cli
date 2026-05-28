import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ICS_CACHE_KEY,
  ICS_ETAG_KEY,
  OWNER_KEY,
  VERSION_KEY,
  addSubscription,
  listSubscriptions,
  patchSubscription,
  removeSubscription,
} from '../src/subscriptions.mjs';

function mockKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (!v) return null;
      return type === 'json' || type?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value, opts) {
      void opts;
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async list() {
      return { keys: Array.from(store.keys()).map(name => ({ name })) };
    },
  };
}

function env() {
  return { WANDERLOG_KV: mockKv() };
}

test('addSubscription creates owner list, bumps version, and invalidates cache', async () => {
  const testEnv = env();
  await testEnv.WANDERLOG_KV.put(ICS_CACHE_KEY, 'cached');
  await testEnv.WANDERLOG_KV.put(ICS_ETAG_KEY, 'etag');

  const entry = await addSubscription(testEnv, { planId: 'TESTTRIP1', title: 'Fixture Coast Trip', alias: 'Fixture' });

  assert.equal(entry.planId, 'TESTTRIP1');
  assert.equal(JSON.parse(await testEnv.WANDERLOG_KV.get(OWNER_KEY))[0].planId, 'TESTTRIP1');
  assert.equal(await testEnv.WANDERLOG_KV.get(VERSION_KEY), '1');
  assert.equal(await testEnv.WANDERLOG_KV.get(ICS_CACHE_KEY), null);
  assert.equal(await testEnv.WANDERLOG_KV.get(ICS_ETAG_KEY), null);
});

test('removeSubscription removes from owner list and bumps version', async () => {
  const testEnv = env();
  await addSubscription(testEnv, { planId: 'TESTTRIP1' });
  const result = await removeSubscription(testEnv, 'TESTTRIP1');

  assert.deepEqual(await listSubscriptions(testEnv), []);
  assert.equal(result.removed, true);
  assert.equal(await testEnv.WANDERLOG_KV.get(VERSION_KEY), '2');
});

test('patchSubscription updates allowed fields', async () => {
  const testEnv = env();
  await addSubscription(testEnv, { planId: 'TESTTRIP1', alias: 'Old' });
  const patched = await patchSubscription(testEnv, 'TESTTRIP1', { alias: 'New', enabled: false, ignored: 'value' });

  assert.equal(patched.alias, 'New');
  assert.equal(patched.enabled, false);
  assert.equal(patched.ignored, undefined);
  assert.equal(await testEnv.WANDERLOG_KV.get(VERSION_KEY), '2');
});

test('listSubscriptions returns the owner list', async () => {
  const testEnv = env();
  await addSubscription(testEnv, { planId: 'TESTTRIP1' });
  await addSubscription(testEnv, { planId: 'TESTTRIP2', timezone: 'Asia/Seoul' });

  const list = await listSubscriptions(testEnv);
  assert.deepEqual(list.map(entry => entry.planId), ['TESTTRIP1', 'TESTTRIP2']);
  assert.equal(list[1].timezone, 'Asia/Seoul');
});
