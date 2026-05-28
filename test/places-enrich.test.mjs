import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseArgs } from '../bin/args.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { parseAiPrefix } from '../src/ai-attribution.mjs';
import { addPlace, toLegacy, toLegacyOpeningHours } from '../src/places.mjs';
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

test('toLegacy maps Google Places v1 details to full Wanderlog legacy place shape', () => {
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
    internationalPhoneNumber: '+1 555-123-4567',
    nationalPhoneNumber: '(555) 123-4567',
    adrFormatAddress: '<span>123 Example Street</span>',
    iconMaskBaseUri: 'https://maps.gstatic.com/mapfiles/place_api/icons/v2/cafe_pinlet',
    utcOffsetMinutes: 540,
    addressComponents: [{ longText: 'Fixture City', shortText: 'Fixture', types: ['locality'] }],
    plusCode: { globalCode: '8Q7XAAAA+AA', compoundCode: 'AAAA+AA Fixture City' },
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
    vicinity: '123 Example Street',
    rating: 4.7,
    user_ratings_total: 123,
    website: 'https://fixture.example',
    url: 'https://maps.google.com/?cid=fixture',
    business_status: 'OPERATIONAL',
    international_phone_number: '+1 555-123-4567',
    formatted_phone_number: '(555) 123-4567',
    adr_address: '<span>123 Example Street</span>',
    icon: 'https://maps.gstatic.com/mapfiles/place_api/icons/v2/cafe_pinlet.png',
    utc_offset: 540,
    address_components: [{ long_name: 'Fixture City', short_name: 'Fixture', types: ['locality'] }],
    plus_code: { global_code: '8Q7XAAAA+AA', compound_code: 'AAAA+AA Fixture City' },
    opening_hours: {
      periods: [{ open: { day: 1, time: '0900' }, close: { day: 1, time: '1800' } }],
      weekday_text: ['Monday: 9:00 AM – 6:00 PM'],
    },
  });
  assert.equal('photo_urls' in legacy, false);
});

test('toLegacy opening_hours detects v1 24-hour period and expands all days', () => {
  const legacy = toLegacyOpeningHours({
    periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    weekdayDescriptions: ['Monday: Open 24 hours'],
  });

  assert.deepEqual(legacy, {
    periods: [0, 1, 2, 3, 4, 5, 6].map(day => ({ open: { day, time: '0000' } })),
    weekday_text: ['Monday: Open 24 hours'],
  });
  assert.equal(legacy.periods.some(period => 'close' in period), false);
});

test('toLegacy opening_hours pads regular v1 times as HHMM strings', () => {
  const legacy = toLegacyOpeningHours({
    periods: [
      { open: { day: 2, hour: 9, minute: 5 }, close: { day: 2, hour: 17, minute: 30 } },
      { open: { day: 3, hour: 0, minute: 0 }, close: { day: 3, hour: 8, minute: 0 } },
    ],
  });

  assert.deepEqual(legacy.periods, [
    { open: { day: 2, time: '0905' }, close: { day: 2, time: '1730' } },
    { open: { day: 3, time: '0000' }, close: { day: 3, time: '0800' } },
  ]);
});

test('toLegacy omits opening_hours when v1 opening hours are missing', () => {
  assert.equal(toLegacyOpeningHours(undefined), undefined);
  assert.equal(toLegacyOpeningHours({}), undefined);
  assert.equal('opening_hours' in toLegacy({
    id: 'places/no-hours',
    displayName: { text: 'No Hours' },
    formattedAddress: 'No Hours Street',
    location: { latitude: 1, longitude: 2 },
  }), false);
});

test('toLegacy maps v1 reviews to legacy review fields and drops undefined values', () => {
  const legacy = toLegacy({
    id: 'places/reviewed',
    displayName: { text: 'Reviewed Place' },
    formattedAddress: 'Reviewed Street',
    location: { latitude: 1, longitude: 2 },
    reviews: [
      {
        authorAttribution: {
          displayName: 'Fixture Reviewer',
          uri: 'https://example.com/reviewer',
          photoUri: 'https://example.com/reviewer.jpg',
        },
        rating: 5,
        relativePublishTimeDescription: 'a month ago',
        text: { text: 'Great stop', languageCode: 'en' },
        publishTime: '2026-01-02T03:04:05Z',
      },
      {
        originalText: { text: 'Original text fallback' },
      },
    ],
  });

  assert.deepEqual(legacy.reviews, [
    {
      author_name: 'Fixture Reviewer',
      author_url: 'https://example.com/reviewer',
      profile_photo_url: 'https://example.com/reviewer.jpg',
      rating: 5,
      relative_time_description: 'a month ago',
      text: 'Great stop',
      time: 1767323045,
      language: 'en',
    },
    {
      text: 'Original text fallback',
    },
  ]);
});

test('new prefix format roundtrips via ai-attribution parser without note hash', () => {
  const parsed = parseAiPrefix('🤵‍♂️ Fixture Cafe');
  assert.deepEqual(parsed, { hash: null, baseName: 'Fixture Cafe', format: 'new' });
  assert.equal(parseAiPrefix('[🤵‍♂️ - abc12345] Fixture Cafe'), null);
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
  assert.deepEqual(insertedBlocks[0].text.ops, [{ insert: '\n' }]);
  assert.doesNotMatch(insertedBlocks[0].text.ops[0].insert, /^\[[a-f0-9]{8}\]\n/u);
  assert.deepEqual(JSON.parse(fetches.find(entry => entry.url.includes('/applyOps')).init.body).ops[0].p, ['itinerary', 'sections', 0, 'blocks', 0]);
});

test('enrich-add command stores only user notes in text ops', async t => {
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

  const result = await createCommandDispatcher({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY', query: 'Fixture Cafe Jeju', notes: 'Breakfast stop' }).execute(
    'places',
    'enrich-add',
    ['TESTTRIP1', 'sec-day-1'],
  );

  assert.equal(result.success, true);
  assert.equal(insertedBlocks[0].place.name, '🤵‍♂️ Fixture Cafe');
  assert.deepEqual(insertedBlocks[0].text.ops, [{ insert: 'Breakfast stop\n' }]);
  assert.doesNotMatch(insertedBlocks[0].text.ops[0].insert, /^\[[a-f0-9]{8}\]\n/u);
});

test('plain add command AI-prefixes title and leaves notes unprefixed', async t => {
  const configDir = await tmpConfigWithToken(t);
  const fetches = [];
  const insertedBlocks = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripFixture(insertedBlocks));
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

  const result = await addPlace({ configDir }, 'TESTTRIP1', 'sec-day-1', {
    name: 'Fixture Cafe',
    lat: '33.4996',
    lng: '126.5312',
    address: '123 Example Street, Fixture City',
    notes: 'Breakfast stop',
  });

  assert.equal(result.name, '🤵‍♂️ Fixture Cafe');
  assert.deepEqual(insertedBlocks[0].text.ops, [{ insert: 'Breakfast stop\n' }]);
  assert.doesNotMatch(insertedBlocks[0].text.ops[0].insert, /^\[[a-f0-9]{8}\]\n/u);
});

test('plain add command without notes stores only blank line text op', async t => {
  const configDir = await tmpConfigWithToken(t);
  const insertedBlocks = [];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripFixture(insertedBlocks));
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

  await addPlace({ configDir }, 'TESTTRIP1', 'sec-day-1', {
    name: 'Fixture Cafe',
    lat: '33.4996',
    lng: '126.5312',
    address: '123 Example Street, Fixture City',
  });

  assert.deepEqual(insertedBlocks[0].text.ops, [{ insert: '\n' }]);
  assert.doesNotMatch(insertedBlocks[0].text.ops[0].insert, /^\[[a-f0-9]{8}\]\n/u);
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
