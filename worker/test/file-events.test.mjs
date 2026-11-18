import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import worker from '../src/index.mjs';
import { handlePublicIcs } from '../src/handlers.mjs';
import {
  EVENTS_SCHEMA,
  MAX_BODY_BYTES,
  fileEventBlocks,
  renderEventsIcs,
  tripEventsKey,
  validateEventsDocument,
} from '../src/file-events.mjs';
import { ICS_CACHE_KEY, ICS_ETAG_KEY, VERSION_KEY, addSubscription, listSubscriptions, removeSubscription } from '../src/subscriptions.mjs';

const FIXTURE = JSON.parse(fs.readFileSync(new URL('./fixtures/calendar-events.json', import.meta.url), 'utf8'));
const clone = value => structuredClone(value);
const ADMIN = 'admin-secret';

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

function testEnv() {
  return { WANDERLOG_KV: mockKv(), ADMIN_TOKEN: ADMIN, WANDERLOG_COOKIE: 'cookie=value' };
}

// Every fetch fails the test unless explicitly allowed: file-sourced feeds must not touch Wanderlog.
function guardFetch(t, handler = null) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (handler) return handler(url, init);
    throw new Error(`unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function putEvents(env, planId, body, { token = ADMIN, raw = null } = {}) {
  return worker.fetch(new Request(`https://calendar.test/wanderlog/api/v1/subscriptions/${planId}/events`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  }), env);
}

const getFeed = env => handlePublicIcs(new Request('https://calendar.test/wanderlog.ics'), env);

test('validator accepts the fixture and rejects schema violations', () => {
  assert.equal(validateEventsDocument(FIXTURE).ok, true);
  const cases = [
    [doc => { doc.schema = 'other'; }, '$.schema'],
    [doc => { doc.extra = 1; }, '$.extra: unknown key'],
    [doc => { doc.events[0].uid = 'tf-OTHER-day-1'; }, '$.events[0].uid'],
    [doc => { doc.events[1].uid = doc.events[0].uid; }, 'duplicate uid'],
    [doc => { doc.events[0].date = '2026-02-30'; }, '$.events[0].date'],
    [doc => { doc.events[1].tz = 'Mars/Olympus'; }, '$.events[1].tz'],
    [doc => { doc.events[1].end = doc.events[1].start; }, 'must be after start'],
    [doc => { doc.events[1].location.lng = undefined; delete doc.events[1].location.lng; }, 'lat and lng'],
    [doc => { doc.events[1].private_note = 'x'; }, 'unknown key'],
    [doc => { doc.events[0].start = '2026-12-03T09:00'; }, 'not allowed when all_day is true'],
    [doc => { doc.events[2].title = ''; }, 'must not be empty'],
  ];
  for (const [mutate, expected] of cases) {
    const doc = clone(FIXTURE);
    mutate(doc);
    const result = validateEventsDocument(doc);
    assert.equal(result.ok, false, expected);
    assert.ok(result.errors.some(e => e.includes(expected)), `${expected}: ${result.errors}`);
  }
  assert.ok(validateEventsDocument(FIXTURE, { planId: 'ELSE' }).errors[0].includes('planId'));
});

test('render: all-day and timed events serialise with stable UIDs and fixed DTSTAMP', () => {
  const ics = renderEventsIcs(FIXTURE, { dtstamp: '20261101T000000Z' });
  assert.equal(ics, renderEventsIcs(clone(FIXTURE), { dtstamp: '20261101T000000Z' }));
  const unfolded = ics.replace(/\r\n[ \t]/g, '');
  assert.match(unfolded, /UID:tf-FIXTRIP1-day-2026-12-03@wanderlog-calendar\r\n/);
  assert.match(unfolded, /DTSTART;VALUE=DATE:20261203\r\nDTEND;VALUE=DATE:20261204\r\n/);
  assert.match(unfolded, /DTSTART;TZID=Asia\/Seoul:20261203T090000\r\nDTEND;TZID=Asia\/Seoul:20261203T100000\r\n/);
  assert.match(unfolded, /DTEND;TZID=Asia\/Seoul:20261204T061500\r\n/);
  assert.match(unfolded, /LOCATION:Fixture Cafe\\, 1 Test St\\, Fixture City\r\nGEO:33.5;126.5\r\n/);
  assert.match(unfolded, /URL:https:\/\/wanderlog.com\/plan\/FIXTRIP1\r\n/);
  assert.ok(ics.split('\r\n').every(line => new TextEncoder().encode(line).length <= 75));
  assert.equal(fileEventBlocks(ics, 'FIXTRIP1').length, 3);
});

test('PUT events: admin auth, schema check, size cap', async t => {
  guardFetch(t);
  const env = testEnv();
  assert.equal((await putEvents(env, 'FIXTRIP1', FIXTURE, { token: 'wrong' })).status, 401);
  assert.equal((await putEvents(env, 'FIXTRIP1', null, { raw: '{not json' })).status, 400);

  const bad = clone(FIXTURE);
  bad.events[1].tz = 'Nowhere/City';
  const badResponse = await putEvents(env, 'FIXTRIP1', bad);
  assert.equal(badResponse.status, 400);
  assert.ok((await badResponse.json()).details.some(d => d.includes('tz')));

  assert.equal((await putEvents(env, 'OTHERTRIP', FIXTURE)).status, 400, 'trip_key must equal the path planId');

  const huge = clone(FIXTURE);
  huge.events[0].description = 'x'.repeat(MAX_BODY_BYTES);
  assert.equal((await putEvents(env, 'FIXTRIP1', huge)).status, 413);

  assert.equal(env.WANDERLOG_KV.store.has(tripEventsKey('FIXTRIP1')), false, 'rejected bodies store nothing');
  assert.deepEqual(await listSubscriptions(env), []);
});

test('PUT events stores the document, switches the subscription to source:file and invalidates the cache', async t => {
  guardFetch(t);
  const env = testEnv();
  await addSubscription(env, { planId: 'FIXTRIP1', alias: 'fixture' });
  await env.WANDERLOG_KV.put(ICS_CACHE_KEY, 'stale');
  await env.WANDERLOG_KV.put(ICS_ETAG_KEY, '"stale"');

  const response = await putEvents(env, 'FIXTRIP1', FIXTURE);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'file');
  assert.equal(body.events, 3);
  assert.match(body.sha256, /^[0-9a-f]{64}$/);

  assert.equal(await env.WANDERLOG_KV.get(ICS_CACHE_KEY), null);
  assert.equal(await env.WANDERLOG_KV.get(ICS_ETAG_KEY), null);
  assert.equal(await env.WANDERLOG_KV.get(VERSION_KEY), '2');
  const [entry] = await listSubscriptions(env);
  assert.equal(entry.source, 'file');
  assert.equal(entry.alias, 'fixture');
  assert.equal(entry.eventsCount, 3);
  assert.deepEqual(JSON.parse(env.WANDERLOG_KV.store.get(tripEventsKey('FIXTRIP1'))), FIXTURE);

  await removeSubscription(env, 'FIXTRIP1');
  assert.equal(env.WANDERLOG_KV.store.has(tripEventsKey('FIXTRIP1')), false);
});

test('source:file feed serves the stored events without fetching Wanderlog and equals the local render', async t => {
  const calls = guardFetch(t);
  const env = testEnv();
  await putEvents(env, 'FIXTRIP1', FIXTURE);
  const response = await getFeed(env);
  assert.equal(response.status, 200);
  const feed = await response.text();
  assert.deepEqual(calls, []);
  assert.deepEqual(fileEventBlocks(feed, 'FIXTRIP1'), fileEventBlocks(renderEventsIcs(FIXTURE), 'FIXTRIP1'));
});

test('a re-publish after the feed was cached replaces the cached feed; UIDs stay stable', async t => {
  guardFetch(t);
  const env = testEnv();
  await putEvents(env, 'FIXTRIP1', FIXTURE);
  const first = await (await getFeed(env)).text();
  assert.ok(await env.WANDERLOG_KV.get(ICS_CACHE_KEY), 'feed cached');

  const changed = clone(FIXTURE);
  changed.events[1].title = 'Brunch at Fixture Cafe';
  changed.events[1].start = '2026-12-03T10:30';
  changed.events[1].end = '2026-12-03T11:30';
  await putEvents(env, 'FIXTRIP1', changed);
  const second = await (await getFeed(env)).text();

  assert.match(second, /SUMMARY:Brunch at Fixture Cafe/);
  assert.doesNotMatch(second, /SUMMARY:Breakfast/);
  const uids = ics => ics.replace(/\r\n[ \t]/g, '').split('\r\n').filter(line => line.startsWith('UID:'));
  assert.deepEqual(uids(second), uids(first));
});

test('mixed feed: Wanderlog subscriptions are still fetched, file subscriptions are not', async t => {
  const calls = guardFetch(t, async url => {
    assert.ok(String(url).includes('/api/tripPlans/LIVE1'), `only LIVE1 may be fetched, got ${url}`);
    return new Response(JSON.stringify({
      tripPlan: {
        key: 'LIVE1',
        startDate: '2026-04-01',
        itinerary: { sections: [{ id: 's1', heading: 'Day 1', blocks: [{ id: 'b1', type: 'place', startTime: '09:00', place: { name: 'Live Cafe' } }] }] },
      },
    }));
  });
  const env = testEnv();
  await addSubscription(env, { planId: 'LIVE1' });
  await putEvents(env, 'FIXTRIP1', FIXTURE);
  const feed = await (await getFeed(env)).text();
  assert.equal(calls.length, 1);
  assert.match(feed, /UID:wlog-LIVE1-s1-b1@wanderlog-calendar/);
  assert.equal(fileEventBlocks(feed, 'FIXTRIP1').length, 3);
});

test('source:file subscription without stored events yields no events and no fetch', async t => {
  const calls = guardFetch(t);
  const env = testEnv();
  await putEvents(env, 'FIXTRIP1', FIXTURE);
  env.WANDERLOG_KV.store.delete(tripEventsKey('FIXTRIP1'));
  await env.WANDERLOG_KV.delete(ICS_CACHE_KEY);
  const response = await worker.fetch(new Request('https://calendar.test/wanderlog/api/v1/refresh', { method: 'POST', headers: { Authorization: `Bearer ${ADMIN}` } }), env);
  const body = await response.json();
  assert.deepEqual(body.failures, [{ planId: 'FIXTRIP1', error: 'no file events published' }]);
  assert.deepEqual(calls, []);
});

test('schema constant matches the doc', () => {
  const doc = fs.readFileSync(new URL('../../docs/calendar-events.md', import.meta.url), 'utf8');
  assert.ok(doc.includes(EVENTS_SCHEMA));
});
