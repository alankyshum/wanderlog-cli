import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from '../bin/args.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { parseAiPrefix } from '../src/ai-attribution.mjs';
import { toLegacy } from '../src/places.mjs';
import { TOKEN_VERSION, saveToken } from '../src/token-store.mjs';

async function tmpConfigWithToken(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-places-enrich-'));
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

test('toLegacy maps Google Places v1 details to minimal Wanderlog place shape', () => {
  const legacy = toLegacy({
    id: 'places/fixture123',
    displayName: { text: 'Fixture Cafe' },
    formattedAddress: '123 Example Street, Fixture City',
    shortFormattedAddress: '123 Example Street',
    location: { latitude: 33.4996, longitude: 126.5312 },
    types: ['cafe', 'point_of_interest'],
    rating: 4.7,
    userRatingCount: 123,
    websiteUri: 'https://fixture.example',
    googleMapsUri: 'https://maps.google.com/?cid=fixture',
    businessStatus: 'OPERATIONAL',
    addressComponents: [{ longText: 'Fixture City', shortText: 'Fixture', types: ['locality'] }],
    regularOpeningHours: {
      periods: [{ open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } }],
      weekdayDescriptions: ['Monday: 9:00 AM – 6:00 PM'],
    },
  });

  assert.deepEqual(legacy, {
    name: 'Fixture Cafe',
    place_id: 'places/fixture123',
    geometry: { location: { lat: 33.4996, lng: 126.5312 } },
    formatted_address: '123 Example Street, Fixture City',
    types: ['cafe', 'point_of_interest'],
    business_status: 'OPERATIONAL',
  });
  assert.equal('opening_hours' in legacy, false);
  assert.equal('photo_urls' in legacy, false);
  assert.equal('address_components' in legacy, false);
  assert.equal('vicinity' in legacy, false);
});

test('new prefix format roundtrips via ai-attribution parser with hash in notes text', () => {
  const parsed = parseAiPrefix('🤵‍♂️ Fixture Cafe\n[deadbeef]\nBreakfast stop\n');
  assert.deepEqual(parsed, { hash: 'deadbeef', baseName: 'Fixture Cafe', format: 'new' });
});

test('enrich-add args parse query, time, no-ai, and google-key flags', () => {
  const parsed = parseArgs([
    'places', 'enrich-add', 'TESTTRIP1', 'sec-day-1',
    '--query', 'Fixture Cafe Jeju',
    '--start', '09:00',
    '--end', '10:30',
    '--no-ai',
    '--google-key', 'GOOGLE_FIXTURE_KEY',
  ]);
  assert.equal(parsed.command, 'places');
  assert.equal(parsed.subcommand, 'enrich-add');
  assert.deepEqual(parsed.positional, ['TESTTRIP1', 'sec-day-1']);
  assert.equal(parsed.options.query, 'Fixture Cafe Jeju');
  assert.equal(parsed.options.start, '09:00');
  assert.equal(parsed.options.end, '10:30');
  assert.equal(parsed.options.noAi, true);
  assert.equal(parsed.options.googleKey, 'GOOGLE_FIXTURE_KEY');
});

test('enrich-add args parse with-photos flag', () => {
  const parsed = parseArgs([
    'places', 'enrich-add', 'TESTTRIP1', 'sec-day-1',
    '--query', 'Fixture Cafe Jeju',
    '--with-photos',
  ]);
  assert.equal(parsed.options.withPhotos, true);
});

test('enrich-add command inserts enriched block and verifies block count increment', async t => {
  const configDir = await tmpConfigWithToken(t);
  const fetches = [];
  const tripBefore = tripFixture([]);
  const insertedBlocks = [];
  const tripAfter = tripFixture(insertedBlocks);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) {
      const body = fetches.filter(entry => entry.url.includes('/api/tripPlans/TESTTRIP1?')).length === 1 ? tripBefore : tripAfter;
      return jsonResponse(body);
    }
    if (String(url).includes('places:searchText')) {
      return jsonResponse({ places: [{ id: 'places/fixture123', displayName: { text: 'Fixture Cafe' } }] });
    }
    if (String(url).includes('/v1/places/places/fixture123')) {
      return jsonResponse({
        id: 'places/fixture123',
        displayName: { text: 'Fixture Cafe' },
        formattedAddress: '123 Example Street, Fixture City',
        shortFormattedAddress: '123 Example Street',
        location: { latitude: 33.4996, longitude: 126.5312 },
        types: ['cafe'],
      });
    }
    if (String(url).includes('/api/tripPlans/TESTTRIP1/applyOps')) {
      const body = JSON.parse(init.body);
      insertedBlocks.push(body.ops[0].li);
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await createCommandDispatcher({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY', query: 'Fixture Cafe Jeju' }).execute(
    'places',
    'enrich-add',
    ['TESTTRIP1', 'sec-day-1'],
  );

  assert.equal(result.success, true);
  assert.equal(result.data.beforeBlockCount, 0);
  assert.equal(result.data.afterBlockCount, 1);
  assert.equal(insertedBlocks.length, 1);
  assert.equal(insertedBlocks[0].place.place_id, 'places/fixture123');
  assert.equal(insertedBlocks[0].place.name, '🤵‍♂️ Fixture Cafe');
  assert.match(insertedBlocks[0].text.ops[0].insert, /^\[[a-f0-9]{8}\]\n/u);
  assert.deepEqual(JSON.parse(fetches.find(entry => entry.url.includes('/applyOps')).init.body).ops[0].p, ['itinerary', 'sections', 0, 'blocks', 0]);
});

test('enrich-add --with-photos expands top three v1 photo media URLs', async t => {
  const configDir = await tmpConfigWithToken(t);
  const fetches = [];
  const tripBefore = tripFixture([]);
  const insertedBlocks = [];
  const tripAfter = tripFixture(insertedBlocks);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) {
      const body = fetches.filter(entry => entry.url.includes('/api/tripPlans/TESTTRIP1?')).length === 1 ? tripBefore : tripAfter;
      return jsonResponse(body);
    }
    if (String(url).includes('places:searchText')) {
      return jsonResponse({ places: [{ id: 'places/fixture123', displayName: { text: 'Fixture Cafe' } }] });
    }
    if (String(url).includes('/v1/places/places/fixture123')) {
      return jsonResponse({
        id: 'places/fixture123',
        displayName: { text: 'Fixture Cafe' },
        formattedAddress: '123 Example Street, Fixture City',
        location: { latitude: 33.4996, longitude: 126.5312 },
        types: ['cafe'],
        businessStatus: 'OPERATIONAL',
        photos: [
          { name: 'places/fixture123/photos/photo-a' },
          { name: 'places/fixture123/photos/photo-b' },
          { name: 'places/fixture123/photos/photo-c' },
          { name: 'places/fixture123/photos/photo-d' },
        ],
      });
    }
    if (String(url).includes('/media?')) {
      const photoName = String(url).match(/photos\/([^/]+)\/media/)?.[1];
      return jsonResponse({ photoUri: `https://lh3.googleusercontent.com/${photoName}` });
    }
    if (String(url).includes('/api/tripPlans/TESTTRIP1/applyOps')) {
      const body = JSON.parse(init.body);
      insertedBlocks.push(body.ops[0].li);
      return jsonResponse({ ok: true });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const result = await createCommandDispatcher({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY', query: 'Fixture Cafe Jeju', withPhotos: true }).execute(
    'places',
    'enrich-add',
    ['TESTTRIP1', 'sec-day-1'],
  );

  assert.equal(result.success, true);
  assert.deepEqual(insertedBlocks[0].place.photo_urls, [
    'https://lh3.googleusercontent.com/photo-a',
    'https://lh3.googleusercontent.com/photo-b',
    'https://lh3.googleusercontent.com/photo-c',
  ]);
  const mediaFetches = fetches.filter(entry => entry.url.includes('/media?'));
  assert.equal(mediaFetches.length, 3);
  assert.match(mediaFetches[0].url, /maxWidthPx=1600/);
  assert.match(mediaFetches[0].url, /skipHttpRedirect=true/);
  assert.match(mediaFetches[0].url, /key=GOOGLE_FIXTURE_KEY/);
});

function tripFixture(blocks) {
  return {
    tripPlan: {
      key: 'TESTTRIP1',
      title: 'Fixture Trip',
      itinerary: {
        sections: [{ id: 'sec-day-1', heading: 'Day 1', blocks }],
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
