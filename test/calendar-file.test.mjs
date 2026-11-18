import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import worker from '../worker/src/index.mjs';
import { publish, render } from '../src/calendar-file.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { parseArgs } from '../bin/args.mjs';

const FIXTURE_FILE = fileURLToPath(new URL('../worker/test/fixtures/calendar-events.json', import.meta.url));

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

// Route the CLI's fetches to an in-process Worker; any other host fails the test.
function useWorker(t, { tamper = null } = {}) {
  const env = { WANDERLOG_KV: mockKv(), ADMIN_TOKEN: 'admin-token' };
  const originalFetch = globalThis.fetch;
  const saved = { token: process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN, url: process.env.WANDERLOG_CALENDAR_URL };
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? 'GET' });
    if (!String(url).startsWith('https://calendar.test/')) throw new Error(`unexpected fetch ${url}`);
    const response = await worker.fetch(new Request(url, init), env);
    if (tamper && String(url).endsWith('/wanderlog.ics')) return new Response(tamper(await response.text()), { status: 200 });
    return response;
  };
  process.env.WANDERLOG_CALENDAR_ADMIN_TOKEN = 'admin-token';
  process.env.WANDERLOG_CALENDAR_URL = 'https://calendar.test';
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, name] of [['token', 'WANDERLOG_CALENDAR_ADMIN_TOKEN'], ['url', 'WANDERLOG_CALENDAR_URL']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
  });
  return { env, requests };
}

test('calendar render prints the Worker serialisation of the events file', async () => {
  const ics = await render({ events: FIXTURE_FILE });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /UID:tf-FIXTRIP1-e-cafe@wanderlog-calendar\r\n/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 3);
});

test('calendar render rejects an invalid events file with a usage error', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-calendar-file-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'events.json');
  const doc = JSON.parse(await fs.readFile(FIXTURE_FILE, 'utf8'));
  doc.events[1].tz = 'Nowhere/City';
  await fs.writeFile(file, JSON.stringify(doc));
  await assert.rejects(render({ events: file }), err => err.exitCode === 2 && /\$\.events\[1\]\.tz/.test(err.message));
  await assert.rejects(render({}), err => err.exitCode === 2);
});

test('calendar publish PUTs the events and verifies the feed equals the local render', async t => {
  const { env, requests } = useWorker(t);
  const first = await publish({ events: FIXTURE_FILE }, 'FIXTRIP1');
  assert.equal(first.verified, true);
  assert.equal(first.events, 3);
  assert.equal(first.source, 'file');
  assert.deepEqual(requests.map(r => `${r.method} ${new URL(r.url).pathname}`), [
    'GET /wanderlog/api/v1/subscriptions',
    'PUT /wanderlog/api/v1/subscriptions/FIXTRIP1/events',
    'GET /wanderlog.ics',
  ]);
  const second = await publish({ events: FIXTURE_FILE }, 'FIXTRIP1');
  assert.equal(second.sha256, first.sha256, 'same file, same digest');
  assert.equal(JSON.parse(env.WANDERLOG_KV.store.get('owner:default:subscriptions')).length, 1);
});

test('calendar publish resolves an alias and refuses a file for another trip', async t => {
  const { env } = useWorker(t);
  await publish({ events: FIXTURE_FILE }, 'FIXTRIP1');
  const patched = await worker.fetch(new Request('https://calendar.test/wanderlog/api/v1/subscriptions/FIXTRIP1', {
    method: 'PATCH',
    headers: { Authorization: 'Bearer admin-token' },
    body: JSON.stringify({ alias: 'coast' }),
  }), env);
  assert.equal(patched.status, 200);
  assert.equal((await publish({ events: FIXTURE_FILE }, 'coast')).planId, 'FIXTRIP1');
  await assert.rejects(publish({ events: FIXTURE_FILE }, 'OTHERTRIP'), err => err.exitCode === 2 && /for FIXTRIP1/.test(err.message));
});

test('calendar publish exits 7 when the served feed differs from the local render', async t => {
  useWorker(t, { tamper: ics => ics.replace('SUMMARY:Breakfast at Fixture Cafe', 'SUMMARY:Something else') });
  await assert.rejects(publish({ events: FIXTURE_FILE }, 'FIXTRIP1'), err => err.exitCode === 7 && /tf-FIXTRIP1-e-cafe/.test(err.message));
});

test('wlog calendar render/publish are registered with an --events flag', async () => {
  const parsed = parseArgs(['calendar', 'publish', 'FIXTRIP1', '--events', 'f.json', '--json']);
  assert.equal(parsed.options.events, 'f.json');
  assert.deepEqual(parsed.args, ['FIXTRIP1']);
  const result = await createCommandDispatcher({ events: FIXTURE_FILE, format: 'json' }).execute('calendar', 'render', []);
  assert.match(result.data.ics, /BEGIN:VEVENT/);
});
