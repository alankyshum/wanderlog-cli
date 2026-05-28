import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createCommandDispatcher } from '../src/commands.mjs';
import { formatOutput } from '../src/output.mjs';
import { checkPlaceStatuses, collectPlaceStatusEntries } from '../src/places.mjs';
import { UsageError } from '../src/errors.mjs';
import { TOKEN_VERSION, saveToken } from '../src/token-store.mjs';

async function tmpConfigWithToken(t) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-places-check-status-'));
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

test('check-status walker collects place ids from mixed itinerary block shapes', () => {
  const entries = collectPlaceStatusEntries(tripPayload().tripPlan);

  assert.deepEqual(entries.map(entry => ({ section: entry.section, blockId: entry['block.id'], name: entry.name, placeId: entry.place_id })), [
    { section: 'East Coast/places[0]', blockId: 'place-1', name: 'Closed Cafe', placeId: 'closed-temp' },
    { section: 'East Coast/places[2]', blockId: 'place-stale', name: 'Stale Place', placeId: 'stale-place-id' },
    { section: 'Flights/KE024.depart', blockId: 'flight-1', name: 'Seoul Incheon Airport', placeId: 'airport-icn' },
    { section: 'Flights/KE024.arrive', blockId: 'flight-1', name: 'Jeju Airport', placeId: 'airport-cju' },
    { section: 'Hotels/lodging.place', blockId: 'hotel-1', name: 'Closed Hotel', placeId: 'closed-perm' },
    { section: 'Rental cars/rentalCar[0].pickUp.place', blockId: 'car-1', name: 'Rental Pickup', placeId: 'car-pickup' },
    { section: 'Rental cars/rentalCar[0].dropOff.place', blockId: 'car-1', name: 'Rental Dropoff', placeId: 'car-dropoff' },
  ]);
});

test('check-status reports surfaced Google Places statuses and hides UNKNOWN by default', async t => {
  const configDir = await tmpConfigWithToken(t);
  const fetches = [];
  installFetch(t, async (url, init = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await checkPlaceStatuses({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY' }, 'TESTTRIP1');

  assert.deepEqual(result.rows, [
    {
      section: 'East Coast/places[0]',
      'block.id': 'place-1',
      name: 'Closed Cafe',
      place_id: 'closed-temp',
      businessStatus: 'CLOSED_TEMPORARILY',
      status: 'CLOSED_TEMPORARILY',
      currentName: 'Google closed-temp',
      url: 'https://maps.example/closed-temp',
    },
    {
      section: 'East Coast/places[2]',
      'block.id': 'place-stale',
      name: 'Stale Place',
      place_id: 'stale-place-id',
      businessStatus: null,
      status: 'PLACE_ID_INVALID',
      currentName: null,
      url: 'https://old.example/stale-place-id',
    },
    {
      section: 'Hotels/lodging.place',
      'block.id': 'hotel-1',
      name: 'Closed Hotel',
      place_id: 'closed-perm',
      businessStatus: 'CLOSED_PERMANENTLY',
      status: 'CLOSED_PERMANENTLY',
      currentName: 'Google closed-perm',
      url: 'https://maps.example/closed-perm',
    },
  ]);
  assert.deepEqual(result.summary, {
    total: 7,
    byStatus: {
      CLOSED_TEMPORARILY: 1,
      PLACE_ID_INVALID: 1,
      OPERATIONAL: 3,
      CLOSED_PERMANENTLY: 1,
      UNKNOWN: 1,
    },
  });
  assert.equal(fetches.filter(entry => entry.url.includes('places.googleapis.com')).length, 7);
  assert.match(fetches.find(entry => entry.url.includes('closed-temp')).url, /fields=id%2CdisplayName%2CbusinessStatus%2CgoogleMapsUri/);
  assert.equal(fetches.find(entry => entry.url.includes('closed-temp')).init.headers['X-Goog-Api-Key'], 'GOOGLE_FIXTURE_KEY');
});

test('check-status maps 404 NOT_FOUND to PLACE_ID_INVALID and continues sweep', async t => {
  const configDir = await tmpConfigWithToken(t);
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await checkPlaceStatuses({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY' }, 'TESTTRIP1');

  assert.equal(result.rows.find(row => row.place_id === 'stale-place-id')?.status, 'PLACE_ID_INVALID');
  assert.equal(result.rows.find(row => row.place_id === 'closed-perm')?.status, 'CLOSED_PERMANENTLY');
});

test('check-status marks missing businessStatus as UNKNOWN and shows it with --show-unknown', async t => {
  const configDir = await tmpConfigWithToken(t);
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await checkPlaceStatuses({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY' }, 'TESTTRIP1', { showUnknown: true });
  const unknown = result.rows.find(row => row.place_id === 'car-dropoff');

  assert.equal(unknown.status, 'UNKNOWN');
  assert.equal(unknown.currentName, 'Google car-dropoff');
  assert.equal(unknown.businessStatus, null);
});

test('check-status batches Google status requests 10 at a time', async t => {
  const configDir = await tmpConfigWithToken(t);
  let inFlight = 0;
  let maxInFlight = 0;
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/BIGTRIP?')) return jsonResponse(bigTripPayload(23));
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return jsonResponse({ id: placeId, displayName: { text: placeId }, businessStatus: 'OPERATIONAL' });
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await checkPlaceStatuses({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY' }, 'BIGTRIP');

  assert.equal(result.rows.length, 0);
  assert.equal(result.summary.total, 23);
  assert.equal(result.summary.byStatus.OPERATIONAL, 23);
  assert.equal(maxInFlight, 10);
});

test('check-status human command output includes summary count', async t => {
  const configDir = await tmpConfigWithToken(t);
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await createCommandDispatcher({ configDir, googleKey: 'GOOGLE_FIXTURE_KEY' }).execute(
    'places',
    'check-status',
    ['TESTTRIP1'],
  );

  assert.match(result.data, /section \| block\.id \| name \| place_id \| status \| currentName \| businessStatus \| url/);
  assert.match(result.data, /7 places checked: 3 operational, 1 closed_temporarily, 1 closed_permanently, 1 place_id_invalid \(run with --show-unknown to also see 1 places without business profile\)/);
  assert.doesNotMatch(result.data, /car-dropoff/);
});

test('check-status --json command output includes summary byStatus breakdown', async t => {
  const configDir = await tmpConfigWithToken(t);
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await createCommandDispatcher({ configDir, format: 'json', json: true, googleKey: 'GOOGLE_FIXTURE_KEY' }).execute(
    'places',
    'check-status',
    ['TESTTRIP1'],
  );
  const parsed = JSON.parse(formatOutput(result.data, { format: 'json' }));

  assert.deepEqual(Object.keys(parsed).sort(), ['rows', 'summary']);
  assert.equal(parsed.summary.total, 7);
  assert.equal(parsed.summary.byStatus.OPERATIONAL, 3);
  assert.equal(parsed.summary.byStatus.UNKNOWN, 1);
  assert.equal(parsed.summary.byStatus.PLACE_ID_INVALID, 1);
  assert.equal(parsed.rows.length, 3);
  assert.equal(parsed.rows[0].businessStatus, 'CLOSED_TEMPORARILY');
  assert.equal(parsed.rows[0].status, 'CLOSED_TEMPORARILY');
  assert.equal(parsed.rows.some(row => row.status === 'UNKNOWN'), false);
});

test('check-status --show-unknown command output includes UNKNOWN rows', async t => {
  const configDir = await tmpConfigWithToken(t);
  installFetch(t, async url => {
    if (String(url).includes('/api/tripPlans/TESTTRIP1?')) return jsonResponse(tripPayload());
    if (String(url).includes('places.googleapis.com/v1/places/')) {
      const placeId = decodeURIComponent(String(url).match(/\/v1\/places\/([^?]+)/)?.[1] || '');
      return googleStatusResponse(placeId);
    }
    throw new Error(`Unexpected fetch ${url}`);
  });

  const result = await createCommandDispatcher({ configDir, showUnknown: true, googleKey: 'GOOGLE_FIXTURE_KEY' }).execute(
    'places',
    'check-status',
    ['TESTTRIP1'],
  );

  assert.match(result.data, /car-dropoff/);
  assert.match(result.data, /UNKNOWN/);
  assert.match(result.data, /7 places checked: 3 operational, 1 closed_temporarily, 1 closed_permanently, 1 place_id_invalid, 1 unknown/);
  assert.doesNotMatch(result.data, /--show-unknown/);
});

test('check-status missing Google key throws usage error with exit code 2', async t => {
  const configDir = await tmpConfigWithToken(t);
  const oldKey = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_MAPS_API_KEY;
  t.after(() => {
    if (oldKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY;
    else process.env.GOOGLE_MAPS_API_KEY = oldKey;
  });

  await assert.rejects(
    () => checkPlaceStatuses({ configDir }, 'TESTTRIP1'),
    err => {
      assert.ok(err instanceof UsageError);
      assert.equal(err.exitCode, 2);
      assert.equal(err.message, 'Set --google-key or $GOOGLE_MAPS_API_KEY');
      return true;
    },
  );
});

function installFetch(t, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function tripPayload() {
  return {
    tripPlan: {
      key: 'TESTTRIP1',
      title: 'Fixture Trip',
      itinerary: {
        sections: [
          {
            id: 'sec-east',
            heading: 'East Coast',
            blocks: [
              { id: 'place-1', type: 'place', place: { name: 'Closed Cafe', place_id: 'closed-temp', url: 'https://old.example/closed-temp' } },
              { id: 'checklist-1', type: 'checklist', items: [{ text: 'No place id here' }] },
              { id: 'place-stale', type: 'place', place: { name: 'Stale Place', place_id: 'stale-place-id', url: 'https://old.example/stale-place-id' } },
            ],
          },
          {
            id: 'sec-flights',
            heading: 'Flights',
            blocks: [
              {
                id: 'flight-1',
                type: 'flight',
                flightNumber: 'KE024',
                depart: { airport: { googlePlace: { name: 'Seoul Incheon Airport', place_id: 'airport-icn' } } },
                arrive: { airport: { googlePlace: { name: 'Jeju Airport', place_id: 'airport-cju' } } },
              },
            ],
          },
          {
            id: 'sec-hotels',
            heading: 'Hotels',
            blocks: [{ id: 'hotel-1', type: 'hotel', place: { name: 'Closed Hotel', place_id: 'closed-perm' } }],
          },
          {
            id: 'sec-cars',
            heading: 'Rental cars',
            blocks: [
              {
                id: 'car-1',
                type: 'rentalCar',
                pickUp: { place: { name: 'Rental Pickup', place_id: 'car-pickup' } },
                dropOff: { place: { name: 'Rental Dropoff', place_id: 'car-dropoff' } },
              },
            ],
          },
        ],
      },
    },
  };
}

function googleStatus(placeId) {
  const statuses = {
    'closed-temp': 'CLOSED_TEMPORARILY',
    'closed-perm': 'CLOSED_PERMANENTLY',
    'airport-icn': 'OPERATIONAL',
    'airport-cju': 'OPERATIONAL',
    'car-pickup': 'OPERATIONAL',
    'car-dropoff': undefined,
  };
  const status = statuses[placeId];
  return {
    id: placeId,
    displayName: { text: `Google ${placeId}` },
    ...(status ? { businessStatus: status } : {}),
    googleMapsUri: `https://maps.example/${placeId}`,
  };
}

function googleStatusResponse(placeId) {
  if (placeId === 'stale-place-id') {
    return jsonResponse({
      error: {
        status: 'NOT_FOUND',
        message: 'The provided Place ID is no longer valid.',
      },
    }, 404);
  }
  return jsonResponse(googleStatus(placeId));
}

function bigTripPayload(count) {
  return {
    tripPlan: {
      key: 'BIGTRIP',
      itinerary: {
        sections: [{
          id: 'sec-big',
          heading: 'Many Places',
          blocks: Array.from({ length: count }, (_, index) => ({
            id: `place-${index}`,
            type: 'place',
            place: { name: `Place ${index}`, place_id: `place-${index}` },
          })),
        }],
      },
    },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
