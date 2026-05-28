import test from 'node:test';
import assert from 'node:assert/strict';

import { handleRefresh } from '../src/handlers.mjs';
import { addSubscription, tripLastFetchKey } from '../src/subscriptions.mjs';

function mockKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      const v = store.get(key);
      if (!v) return null;
      return type === 'json' || type?.type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
  };
}

test('refresh skips failed trip fetches and reports failures', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async url => {
    if (String(url).includes('/VALID')) {
      return new Response(JSON.stringify({
        tripPlan: {
          key: 'VALID',
          title: 'Valid Trip',
          startDate: '2026-04-01',
          itinerary: {
            sections: [{
              id: 'day-1',
              heading: 'Day 1',
              blocks: [{
                id: 'block-1',
                type: 'place',
                place: { name: 'Valid Cafe', formatted_address: '1 Test St' },
              }],
            }],
          },
        },
      }));
    }
    return new Response('missing', { status: 404 });
  };

  const env = { WANDERLOG_KV: mockKv(), WANDERLOG_COOKIE: 'cookie=value' };
  await addSubscription(env, { planId: 'VALID' });
  await addSubscription(env, { planId: 'MISSING' });

  const response = await handleRefresh(new Request('https://calendar.test/wanderlog/api/v1/refresh', { method: 'POST' }), env);
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.refreshed, true);
  assert.deepEqual(body.failures, [{ planId: 'MISSING', error: 'upstream not found' }]);
  assert.equal(JSON.parse(await env.WANDERLOG_KV.get(tripLastFetchKey('VALID'))).ok, true);
  assert.equal(JSON.parse(await env.WANDERLOG_KV.get(tripLastFetchKey('MISSING'))).ok, false);
});
