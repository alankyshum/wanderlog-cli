import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { subscribe, unsubscribe } from '../src/calendar.mjs';
import { saveToken } from '../src/token-store.mjs';

async function tokenDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-calendar-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await saveToken({ configDir: dir }, {
    version: 1,
    baseUrl: 'https://wanderlog.test',
    userId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cookies: [{ name: 'connect.sid', value: 'fixture', domain: 'wanderlog.test', path: '/' }],
  });
  return dir;
}

test('calendar subscribe resolves title aliases to canonical trip key before writing KV', async t => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN;
  const originalUrl = process.env.WANDERLOG_CALENDAR_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN = originalToken;
    process.env.WANDERLOG_CALENDAR_URL = originalUrl;
  });

  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).startsWith('https://wanderlog.test/api/tripPlans?')) {
      return new Response(JSON.stringify([{ key: 'TRIP123', title: 'Jeju' }]));
    }
    if (String(url).startsWith('https://wanderlog.test/api/tripPlans/TRIP123')) {
      return new Response(JSON.stringify({ tripPlan: { key: 'TRIP123', title: 'Jeju', sections: [] } }));
    }
    if (String(url).startsWith('https://calendar.test/wanderlog/api/v1/subscriptions')) {
      assert.equal(JSON.parse(init.body).planId, 'TRIP123');
      return new Response(JSON.stringify({ planId: 'TRIP123', alias: 'jeju' }));
    }
    return new Response('not found', { status: 404 });
  };
  process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN = 'admin-token';
  process.env.WANDERLOG_CALENDAR_URL = 'https://calendar.test';

  const result = await subscribe({ configDir: await tokenDir(t) }, { tripKey: 'Jeju', alias: 'jeju' });

  assert.equal(result.planId, 'TRIP123');
  assert.ok(requests.some(request => request.url.includes('/api/tripPlans?userId=')));
});

test('calendar unsubscribe resolves subscription alias to planId', async t => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN;
  const originalUrl = process.env.WANDERLOG_CALENDAR_URL;
  t.after(() => {
    globalThis.fetch = originalFetch;
    process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN = originalToken;
    process.env.WANDERLOG_CALENDAR_URL = originalUrl;
  });

  let deletedPath = null;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === undefined || init.method === 'GET') {
      return new Response(JSON.stringify({ subscriptions: [{ planId: 'TRIP123', alias: 'jeju', title: 'Jeju' }] }));
    }
    if (init.method === 'DELETE') {
      deletedPath = new URL(url).pathname;
      return new Response(JSON.stringify({ removed: true, planId: 'TRIP123' }));
    }
    return new Response('not found', { status: 404 });
  };
  process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN = 'admin-token';
  process.env.WANDERLOG_CALENDAR_URL = 'https://calendar.test';

  const result = await unsubscribe({}, 'jeju');

  assert.equal(result.planId, 'TRIP123');
  assert.equal(deletedPath, '/wanderlog/api/v1/subscriptions/TRIP123');
});
