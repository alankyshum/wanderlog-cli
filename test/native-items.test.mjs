// Native flight, train and rental-car items, travelMode on place cards, the Wanderlog place
// resolver and travel-time reads. Shapes: spike S7 (throwaway trip, branch trip-sync/spike) and
// read-only W6b captures in test/fixtures/place-reads.json. Offline: globalThis.fetch is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXIT, analyse, applyJson0, assertBatchSchema, buildApplyBatch, canon, checkBlockSchema, normBlock, strip, writeBlock,
} from '../src/sync.mjs';
import { airlineList, completeAirlines, loadDesired, runSync } from '../src/sync-cli.mjs';
import { validateTripPlanStructure } from '../src/validation.mjs';
import { parseArgs } from '../bin/args.mjs';
import { parseDetails, parseDistanceInfo, parseDistances, parseNear, parseSearchRows, placeTravel, resolvePlace, tripLegs } from '../src/place-reads.mjs';

const FX = JSON.parse(readFileSync(new URL('./fixtures/place-reads.json', import.meta.url), 'utf8'));
const TRIP = 'nativetripkey001';
const OWNER = 4242;
const opts = { cookies: [{ name: 'connect.sid', value: 'FAKEVALUE' }] };
const clone = v => structuredClone(v);
const ops = text => ({ ops: [{ insert: `${text}\n` }] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

const PID = {
  HKG: 'ChIJncZGzPPiAzQRnjaSGIKQ9fk', KIX: 'ChIJ9_rNIxO5AGARiI-QjZ-ncfE', WTS: 'ChIJ31a6-dgGBDQRDBc7avv7pyA',
  WTS_D2: 'ChIJHV6ZSQYHBDQR1hI5y2nWmaU', TUNG_CHUNG: 'ChIJwXMVrLriAzQRcMQVFWJ-Hsg', KYOTO: 'ChIJ7wKLka4IAWARCByidG5EGrY', KIX_STN: 'ChIJ1wO5URO5AGARXZucj1YFJhI',
};
const place = (name, id, lat, lng, address = '') => ({ name, place_id: id, formatted_address: address, geometry: { location: { lat, lng } } });
const HKG = place('Hong Kong International Airport', PID.HKG, 22.3134736, 113.9137283, '1 Sky Plaza Rd, Chek Lap Kok, Hong Kong');
const KIX = place('Kansai International Airport', PID.KIX, 34.4319994, 135.2366019, 'Izumisano, Osaka, Japan');
const WTS = place('Wong Tai Sin', PID.WTS, 22.34166, 114.19385, 'Chuk Un, Kowloon, Hong Kong');
const KIX_STN = place('Kansai-Airport Station', PID.KIX_STN, 34.4358892, 135.243459, 'Tajiri, Osaka, Japan');
const KYOTO = place('Kyoto Station', PID.KYOTO, 34.985849, 135.7587667, 'Shimogyo Ward, Kyoto, Japan');
const KYOTO_GEO = { type: 'geo', value: { id: 2, name: 'Kyoto', countryName: 'Japan', latitude: 35.007576, longitude: 135.75949 } };

// Desired blocks, in the normal form the vault emits (no Wanderlog bookkeeping).
const FLIGHT = {
  key: 'cx502', id: 510000001, type: 'flight', new: true, text: ops('CX502 to Osaka'), confirmationNumber: 'PNR123',
  flightInfo: { airline: { iata: 'CX', icao: 'CPA', name: 'Cathay Pacific', localizedName: 'Cathay Pacific' }, number: 502 },
  depart: { airport: { iata: 'HKG', name: 'Hong Kong International Airport', cityName: 'Hong Kong', googlePlace: HKG }, date: '2027-03-02', time: '16:40' },
  arrive: { airport: { iata: 'KIX', name: 'Kansai International Airport', cityName: 'Osaka', googlePlace: KIX }, date: '2027-03-02', time: '21:05' },
};
const TRAIN = {
  key: 'haruka', id: 510000002, type: 'train', new: true, text: ops('Haruka'), confirmationNumber: '', carrier: 'JR West Haruka 18',
  depart: { place: KIX_STN, date: '2027-03-02', time: '22:16' }, arrive: { place: KYOTO, date: '2027-03-02', time: '23:31' },
};
const CAR = {
  key: 'kyoto-car', id: 510000003, type: 'rentalCar', new: true, text: ops('Car'),
  pickUp: { airportOrGeo: KYOTO_GEO, place: place('Kyoto', 'ChIJ8cM8zdaoAWARPR27azYdlsA', 35.011564, 135.7681489, 'Japan'), date: '2027-03-02' },
  dropOff: { airportOrGeo: KYOTO_GEO, place: place('Kyoto', 'ChIJ8cM8zdaoAWARPR27azYdlsA', 35.011564, 135.7681489, 'Japan'), date: '2027-03-02', time: '20:00' },
};
const CHECKIN = { key: 'hkg-checkin', id: 510000004, type: 'place', new: true, place: HKG, text: ops('Check in'), startTime: '14:00', endTime: '15:00', travelMode: 'transit' };
const LODGING = { key: 'wts-stay', id: 510000005, type: 'place', new: true, place: WTS, text: ops('Stay'), hotel: { checkIn: '2027-03-01', checkOut: '2027-03-02', confirmationNumber: '' } };

function baseDoc() {
  const day = (id, date) => ({ id, type: 'normal', mode: 'dayPlan', heading: '', date, blocks: [], text: { ops: [{ insert: '\n' }] } });
  return {
    success: true,
    tripPlan: {
      key: TRIP, userId: OWNER, overallVersion: 3, startDate: '2027-03-01', endDate: '2027-03-02', editKey: 'EDITSECRET01',
      itinerary: {
        sections: [
          { id: 400000001, type: 'textOnly', mode: 'placeList', heading: 'Notes', text: { ops: [{ insert: '\n' }] }, blocks: [] },
          { id: 400000002, type: 'normal', mode: 'placeList', heading: 'Places to visit', date: null, text: { ops: [{ insert: '\n' }] }, blocks: [] },
          day(400000011, '2027-03-01'),
          day(400000012, '2027-03-02'),
        ],
      },
    },
  };
}

function desiredDoc({ car = false } = {}) {
  const sections = [
    { key: 'list:flights', id: 410000001, new: true, type: 'flights', mode: 'placeList', heading: 'Flights', blocks: [clone(FLIGHT)] },
    { key: 'list:hotels', id: 410000002, new: true, type: 'hotels', mode: 'placeList', heading: 'Hotels and lodging', blocks: [clone(LODGING)] },
    ...(car ? [{ key: 'list:cars', id: 410000003, new: true, type: 'rentalCars', mode: 'placeList', heading: 'Rental cars', blocks: [clone(CAR)] }] : []),
    { key: 'list:transit', id: 410000004, new: true, type: 'transit', mode: 'placeList', heading: 'Transit', blocks: [clone(TRAIN)] },
    { key: 'day:2027-03-01', id: null, type: 'normal', mode: 'dayPlan', heading: '', date: '2027-03-01', blocks: [] },
    { key: 'day:2027-03-02', id: null, type: 'normal', mode: 'dayPlan', heading: '', date: '2027-03-02', blocks: [clone(CHECKIN)] },
  ];
  return { desired_version: 1, sections };
}

const EMPTY_LOCK = { lock_version: 1, sections: {}, entries: {} };

function tmpFiles(map) {
  const dir = mkdtempSync(join(tmpdir(), 'wlog-native-test-'));
  const out = {};
  for (const [name, value] of Object.entries(map)) {
    out[name] = join(dir, `${name}.json`);
    writeFileSync(out[name], JSON.stringify(value));
  }
  return out;
}

// In-memory Wanderlog for the trip, plus the read-only places, directions and airline endpoints.
function fakeServer(t, doc) {
  const state = { doc: clone(doc), posts: [], gets: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    state.gets.push(u.pathname);
    if (init.method === 'POST' && u.pathname === `/api/tripPlans/${TRIP}/applyOps`) {
      const { ops: batch } = JSON.parse(init.body);
      state.posts.push(batch);
      const next = clone(state.doc);
      try {
        applyJson0(next.tripPlan, batch);
      } catch (err) {
        return json({ success: false, error: err.message });
      }
      next.tripPlan.overallVersion += 1;
      state.doc = next;
      return json({ success: true });
    }
    if (u.pathname === `/api/tripPlans/${TRIP}`) return json(clone(state.doc));
    if (u.pathname === '/api/flights/allAirlines') return json(state.airlines ?? FX.allAirlines);
    if (u.pathname === '/api/placesAPI/searchPlaces') return json(state.search ?? FX.searchPlaces);
    if (u.pathname === '/api/placesAPI/getPlaceDetails/v2') return json(state.details?.(u.searchParams.get('placeId')) ?? FX.details[u.searchParams.get('placeId')] ?? { success: false });
    if (u.pathname === '/api/directions/allDistanceInfoForPlace/v2') return json(FX.allDistanceInfoForPlace);
    return json({ error: 'not found' }, 404);
  };
  t.after(() => { globalThis.fetch = original; });
  return state;
}

// ---------- builders and normal form ----------

test('builders give flight, train and rental car blocks the native field set; normal form round-trips', () => {
  for (const d of [FLIGHT, TRAIN, CAR]) {
    const want = strip(d);
    const raw = writeBlock(want, undefined, OWNER);
    assert.deepEqual(checkBlockSchema(raw), [], `${d.type} schema`);
    assert.deepEqual(raw.addedBy, { type: 'user', userId: OWNER });
    assert.deepEqual(raw.attachments, []);
    assert.equal(canon(normBlock(raw)), canon(want), `${d.type} round trip`);
  }
  const flight = writeBlock(strip(FLIGHT), undefined, OWNER);
  assert.deepEqual(flight.travelerNames, []);
  assert.equal(flight.depart.type, 'depart');
  assert.equal(flight.arrive.type, 'arrive');
  assert.deepEqual(flight.depart.airport.googlePlace.types, ['airport']);
  assert.equal(flight.flightInfo.number, 502);
  const train = writeBlock(strip(TRAIN), undefined, OWNER);
  assert.deepEqual(Object.keys(train).sort(), ['addedBy', 'arrive', 'attachments', 'carrier', 'confirmationNumber', 'depart', 'id', 'text', 'type']);
  const car = writeBlock(strip(CAR), undefined, OWNER);
  assert.equal(car.pickUp.time, null, 'an unset time is written as null, as the web app does');
  assert.ok(!('confirmationNumber' in car), 'a rental car without a confirmation number has none (web-app shape)');
  assert.deepEqual(car.pickUp.airportOrGeo, KYOTO_GEO);
});

test('a rewritten flight keeps unmodelled fields while the Google id is unchanged and drops them when it changes', () => {
  const old = writeBlock(strip(FLIGHT), undefined, OWNER);
  old.depart.airport.googlePlace = { ...old.depart.airport.googlePlace, utc_offset: 480, rating: 4.5, types: ['international_airport', 'airport'] };
  old.travelerNames = ['A'];
  old.flightInfo.extra = 'kept';
  const sameAirport = writeBlock({ ...strip(FLIGHT), confirmationNumber: 'NEW' }, old, OWNER);
  assert.equal(sameAirport.depart.airport.googlePlace.utc_offset, 480);
  assert.deepEqual(sameAirport.travelerNames, ['A']);
  assert.equal(sameAirport.flightInfo.extra, 'kept');
  assert.equal(sameAirport.confirmationNumber, 'NEW');
  const moved = strip(FLIGHT);
  moved.depart.airport = { iata: 'KIX', name: 'Kansai International Airport', cityName: 'Osaka', googlePlace: KIX };
  const other = writeBlock(moved, old, OWNER);
  assert.ok(!('utc_offset' in other.depart.airport.googlePlace));
  assert.deepEqual(other.depart.airport.googlePlace.types, ['airport']);
});

test('place cards model travelMode (null is absent) and list cards keep startTime/endTime', () => {
  const raw = writeBlock(strip(CHECKIN), undefined, OWNER);
  assert.equal(raw.travelMode, 'transit');
  assert.equal(raw.startTime, '14:00');
  assert.deepEqual(checkBlockSchema(raw), []);
  assert.equal(normBlock(raw).travelMode, 'transit');
  assert.ok(!('travelMode' in normBlock({ ...raw, travelMode: null })));
  assert.ok(!('travelMode' in strip({ ...CHECKIN, travelMode: null })));
  const cleared = writeBlock(strip({ ...CHECKIN, travelMode: null }), raw, OWNER);
  assert.equal(cleared.travelMode, null);
  assert.deepEqual(checkBlockSchema({ ...raw, travelMode: 'flying' }), ['travelMode']);
});

// ---------- schema refusals ----------

test('the pre-post schema check names each missing native field and refuses the batch (exit 3)', () => {
  const flight = writeBlock(strip(FLIGHT), undefined, OWNER);
  const cases = [
    [{ ...flight, addedBy: undefined }, 'addedBy'],
    [{ ...flight, travelerNames: undefined }, 'travelerNames'],
    [{ ...flight, attachments: undefined }, 'attachments'],
    [{ ...flight, confirmationNumber: null }, 'confirmationNumber'],
    [{ ...flight, text: undefined }, 'text'],
    [{ ...flight, flightInfo: { airline: { iata: 'CX' }, number: 502 } }, 'flightInfo.airline'],
    [{ ...flight, flightInfo: { ...flight.flightInfo, number: 'CX502' } }, 'flightInfo.number'],
    [{ ...flight, depart: { ...flight.depart, date: null } }, 'depart.date'],
    [{ ...flight, depart: { ...flight.depart, type: 'arrive' } }, 'depart.type'],
    [{ ...flight, arrive: { ...flight.arrive, airport: { ...flight.arrive.airport, iata: 'kix' } } }, 'arrive.airport'],
    [{ ...flight, arrive: { ...flight.arrive, airport: { ...flight.arrive.airport, googlePlace: { name: 'x' } } } }, 'arrive.airport.googlePlace.geometry.location'],
  ];
  for (const [block, field] of cases) assert.ok(checkBlockSchema(block).includes(field), `${field}: ${checkBlockSchema(block)}`);
  const train = writeBlock(strip(TRAIN), undefined, OWNER);
  assert.deepEqual(checkBlockSchema({ ...train, carrier: undefined }), ['carrier']);
  assert.deepEqual(checkBlockSchema({ ...train, arrive: { ...train.arrive, time: '25:00' } }), ['arrive.time']);
  const car = writeBlock(strip(CAR), undefined, OWNER);
  assert.deepEqual(checkBlockSchema({ ...car, dropOff: { ...car.dropOff, airportOrGeo: null } }), ['dropOff.airportOrGeo']);
  assert.throws(() => assertBatchSchema([{ p: ['itinerary', 'sections', 1, 'blocks'], oi: [{ ...flight, travelerNames: undefined }] }], []),
    err => err.exitCode === EXIT.refused && /block 510000001 \(flight\) lacks travelerNames/.test(err.message));
});

test('desired flights, trains and rental cars missing builder inputs are refused at load (exit 2)', () => {
  const bad = [
    [d => { d.sections[4].blocks.push(clone(FLIGHT)); }, /section day:2027-03-02 has a block without key, integer id or a place\/note\/checklist type/],
    [d => { d.sections[0].blocks[0].depart.date = undefined; }, /flight cx502 needs depart.date/],
    [d => { d.sections[0].blocks[0].arrive.airport.iata = 'Osaka'; }, /needs arrive.airport \{iata, name, cityName\}/],
    [d => { d.sections[0].blocks[0].flightInfo.number = '502'; }, /needs an integer flightInfo.number/],
    [d => { d.sections[0].blocks[0].flightInfo.airline = { name: 'Cathay' }; }, /needs flightInfo.airline.iata/],
    [d => { d.sections[2].blocks[0].depart.place = { name: 'x' }; }, /train haruka needs depart.place/],
    [d => { d.sections[2].blocks[0].arrive.time = '9:00'; }, /arrive.time must be HH:MM/],
    [d => { d.sections[4].blocks.push({ ...clone(CHECKIN), key: 'c2', id: 510000099, travelMode: 'flying' }); }, /travelMode must be null or one of driving, walking, transit/],
    [d => { d.sections.push({ ...clone(d.sections[0]), key: 'list:flights2', id: 410000099 }); }, /two flights sections \(list:flights, list:flights2\)/],
    [d => { d.sections[0].mode = 'dayPlan'; }, /must use mode placeList/],
    [d => { d.sections.splice(2, 0, { key: 'list:cars', id: 410000003, new: true, type: 'rentalCars', mode: 'placeList', heading: 'Rental cars', blocks: [{ ...clone(CAR), pickUp: { ...clone(CAR.pickUp), airportOrGeo: undefined } }] }); }, /needs pickUp.airportOrGeo/],
  ];
  for (const [mutate, message] of bad) {
    const d = desiredDoc();
    mutate(d);
    const f = tmpFiles({ d });
    assert.throws(() => loadDesired(f.d), err => err.exitCode === EXIT.usage && message.test(err.message), String(message));
  }
  assert.equal(loadDesired(tmpFiles({ d: desiredDoc({ car: true }) }).d).sections.length, 6);
});

// ---------- airline completion ----------

test('an airline given by IATA code alone is completed from Wanderlog\'s airline list; ambiguity and bad shapes fail closed', async t => {
  const server = fakeServer(t, baseDoc());
  const d = desiredDoc();
  d.sections[0].blocks[0].flightInfo.airline = { iata: 'CX' };
  await completeAirlines(opts, d);
  assert.deepEqual(d.sections[0].blocks[0].flightInfo.airline, { iata: 'CX', icao: 'CPA', name: 'Cathay Pacific', localizedName: 'Cathay Pacific' });
  const complete = desiredDoc();
  const before = server.gets.length;
  await completeAirlines(opts, complete);
  assert.equal(server.gets.length, before, 'a complete airline needs no fetch');
  const jl = desiredDoc();
  jl.sections[0].blocks[0].flightInfo.airline = { iata: 'JL' };
  await assert.rejects(() => completeAirlines(opts, jl), err => err.exitCode === EXIT.usage && /JL matches 2 Wanderlog airlines/.test(err.message));
  const jal = desiredDoc();
  jal.sections[0].blocks[0].flightInfo.airline = { iata: 'JL', icao: 'JAL', name: 'Japan Airlines' };
  await completeAirlines(opts, jal);
  assert.deepEqual(jal.sections[0].blocks[0].flightInfo.airline, { iata: 'JL', icao: 'JAL', name: 'Japan Airlines', localizedName: 'Japan Airlines' });
  const nobody = desiredDoc();
  nobody.sections[0].blocks[0].flightInfo.airline = { iata: 'JL', icao: 'XXX' };
  await assert.rejects(() => completeAirlines(opts, nobody), /JL\/XXX matches 0 Wanderlog airlines/);
  const wrong = desiredDoc();
  wrong.sections[0].blocks[0].flightInfo.airline = { iata: 'CX', name: 'Dragonair' };
  await assert.rejects(() => completeAirlines(opts, wrong), /name "Dragonair" differs from Wanderlog's "Cathay Pacific"/);
  assert.throws(() => airlineList({ success: true, data: { CX: {} } }), err => err.exitCode === EXIT.fetch);
  assert.throws(() => airlineList({ success: true, data: [{ iata: 5 }] }), /row 0 has an unexpected shape/);
});

// ---------- sections, guards, apply ----------

test('flights, rental cars and transit are created natively in the web app\'s order, then apply is verified and a second plan is 0 ops', async t => {
  const server = fakeServer(t, baseDoc());
  const desired = desiredDoc({ car: true });
  desired.sections[0].blocks[0].flightInfo.airline = { iata: 'CX' };
  const f = tmpFiles({ desired, lock: EMPTY_LOCK });
  const plan = JSON.parse((await runSync({ ...opts, desired: f.desired, last: f.lock }, 'plan', [TRIP])).rawOutput);
  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.ops.map(o => `${o.op} ${o.section}`), [
    'insert_section list:flights', 'insert_section list:hotels', 'insert_section list:cars', 'insert_section list:transit', 'replace_blocks day:2027-03-02',
  ]);
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '3' }, 'apply', [TRIP]);
  assert.equal(result.exitCode, 0, result.rawOutput);
  const out = JSON.parse(result.rawOutput);
  assert.equal(out.verified, true);
  assert.equal(server.posts.length, 1);
  const sections = server.doc.tripPlan.itinerary.sections;
  assert.deepEqual(sections.map(s => s.type), ['textOnly', 'flights', 'hotels', 'rentalCars', 'transit', 'normal', 'normal', 'normal']);
  const shape = s => { const { blocks, ...rest } = s; return rest; };
  assert.deepEqual(shape(sections[1]), { id: 410000001, heading: 'Flights', type: 'flights', mode: 'placeList', text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#3498db', placeMarkerIcon: 'plane' });
  assert.deepEqual(shape(sections[3]), { id: 410000003, heading: 'Rental cars', type: 'rentalCars', mode: 'placeList', text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#38a4a6', placeMarkerIcon: 'car' });
  assert.deepEqual(shape(sections[4]), { id: 410000004, heading: 'Transit', type: 'transit', mode: 'placeList', text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#17b978', placeMarkerIcon: 'subway' });
  for (const s of sections) for (const b of s.blocks) assert.deepEqual(checkBlockSchema(b), [], `block ${b.id}`);
  assert.equal(sections[1].blocks[0].flightInfo.airline.icao, 'CPA');
  assert.equal(sections[7].blocks[0].travelMode, 'transit');
  assert.equal(validateTripPlanStructure(server.doc, { checkDates: true }).valid, true);

  // Lock as the vault writes it from the apply output; a second plan is 0 ops and 0 drift.
  const sectionIds = { 'list:flights': 410000001, 'list:hotels': 410000002, 'list:cars': 410000003, 'list:transit': 410000004, ...out.resolved };
  const entries = {};
  for (const s of desired.sections) for (const b of s.blocks) entries[b.key] = { block: b.id, hash: out.hashes.entries[b.key] };
  const lock = { lock_version: 1, sections: sectionIds, entries, section_hashes: out.hashes.sections };
  const again = desiredDoc({ car: true });
  for (const s of again.sections) {
    s.id = sectionIds[s.key];
    s.new = false;
    for (const b of s.blocks) b.new = false;
  }
  const g = tmpFiles({ again, lock });
  const second = JSON.parse((await runSync({ ...opts, desired: g.again, last: g.lock }, 'plan', [TRIP])).rawOutput);
  assert.equal(second.op_count, 0, JSON.stringify(second.ops));
  assert.deepEqual(second.drift, []);

  // An app edit to a flight is drift on the modelled field.
  server.doc.tripPlan.itinerary.sections[1].blocks[0].depart.time = '17:00';
  const drift = JSON.parse((await runSync({ ...opts, desired: g.again, last: g.lock }, 'plan', [TRIP])).rawOutput).drift;
  assert.deepEqual(drift.map(r => [r.key, r.field, r.wanderlog.time, r.file.time]), [['cx502', 'depart', '17:00', '16:40']]);
});

test('an existing Flights or Transit section takes the new one\'s place; two are refused; unknown block types are refused', () => {
  const doc = baseDoc();
  const flights = { id: 420000001, type: 'flights', mode: 'placeList', heading: 'Flights', text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#3498db', placeMarkerIcon: 'plane', blocks: [] };
  doc.tripPlan.itinerary.sections.splice(1, 0, flights);
  const found = analyse(doc, desiredDoc(), EMPTY_LOCK);
  assert.equal(found.resolved['list:flights'], 420000001);
  assert.ok(!found.ops.some(o => o.op === 'insert_section' && o.section === 'list:flights'));
  const two = clone(doc);
  two.tripPlan.itinerary.sections.splice(1, 0, { ...clone(flights), id: 420000002 });
  assert.ok(analyse(two, desiredDoc(), EMPTY_LOCK).refusals.includes('desired section list:flights matches 2 Wanderlog sections'));
  const bus = clone(doc);
  bus.tripPlan.itinerary.sections[1].blocks.push({ id: 7, type: 'bus' });
  assert.ok(analyse(bus, desiredDoc(), EMPTY_LOCK).refusals.includes("unknown block type 'bus' in managed section 420000001"));
  const placeInFlights = clone(doc);
  placeInFlights.tripPlan.itinerary.sections[1].blocks.push({ id: 8, type: 'place', place: HKG });
  assert.ok(analyse(placeInFlights, desiredDoc(), EMPTY_LOCK).refusals.includes("unknown block type 'place' in managed section 420000001"));
});

test('a batch that rewrites reservation blocks compares their identity strings first', () => {
  const doc = baseDoc();
  const flight = writeBlock(strip(FLIGHT), undefined, OWNER);
  const train = writeBlock(strip(TRAIN), undefined, OWNER);
  doc.tripPlan.itinerary.sections.splice(1, 0,
    { id: 410000001, type: 'flights', mode: 'placeList', heading: 'Flights', text: { ops: [{ insert: '\n' }] }, blocks: [flight] },
    { id: 410000004, type: 'transit', mode: 'placeList', heading: 'Transit', text: { ops: [{ insert: '\n' }] }, blocks: [train] });
  const desired = desiredDoc();
  desired.sections = desired.sections.filter(s => s.key !== 'list:hotels');
  for (const s of desired.sections) {
    s.new = false;
    for (const b of s.blocks) b.new = false;
  }
  desired.sections[0].blocks[0].confirmationNumber = 'CHANGED';
  desired.sections[1].blocks[0].carrier = 'JR West Haruka 20';
  desired.sections[3].blocks = [];
  const found = analyse(doc, desired, EMPTY_LOCK);
  const { components } = buildApplyBatch(doc, found.desired, EMPTY_LOCK);
  const compares = components.filter(c => c.t === 'text0').map(c => `${c.p.slice(2).join('.')}=${c.o[0].d}`);
  assert.deepEqual(compares, [
    '1.heading=Flights', '1.blocks.0.depart.airport.iata=HKG', '1.blocks.0.flightInfo.airline.iata=CX', '1.blocks.0.depart.date=2027-03-02',
    '2.heading=Transit', '2.blocks.0.depart.place.name=Kansai-Airport Station', '2.blocks.0.depart.date=2027-03-02',
  ]);
  // A stale fetch (the app changed the departure airport) fails the whole batch on the server.
  const stale = clone(doc.tripPlan);
  stale.itinerary.sections[1].blocks[0].depart.airport.iata = 'HKX';
  assert.throws(() => applyJson0(stale, components), /does not match/);
});

// ---------- resolver ----------

test('places resolve ranks Wanderlog search results with details and never picks one', async t => {
  const server = fakeServer(t, baseDoc());
  server.details = id => (id === PID.WTS ? FX.details[PID.WTS] : { success: true, data: { ...FX.details[PID.WTS].data, place_id: id, name: `Place ${id}` } });
  const out = await resolvePlace(opts, { query: 'Wong Tai Sin Station', near: '22.34,114.19' });
  assert.deepEqual(out.near, { lat: 22.34, lng: 114.19, radius: 50000 });
  assert.equal(out.source, 'wanderlog');
  assert.deepEqual(out.candidates.map(c => c.rank), [1, 2, 3]);
  assert.deepEqual(out.candidates[0], { rank: 1, place_id: PID.WTS, name: 'Wong Tai Sin', lat: 22.341659999999997, lng: 114.19385, address: 'Chuk Un, Kowloon, Hong Kong', types: ['subway_station'] });
  assert.deepEqual(Object.keys(out).sort(), ['candidates', 'near', 'query', 'source'], 'no chosen or pinned field');
  assert.ok(server.gets.every(p => p.startsWith('/api/placesAPI/')), 'read-only places endpoints only');
  const anywhere = await resolvePlace(opts, { query: 'Wong Tai Sin Station' });
  assert.equal(anywhere.near, null);
  const byId = await resolvePlace(opts, { placeId: PID.WTS });
  assert.equal(byId.candidates.length, 1);
  await assert.rejects(() => resolvePlace(opts, {}), /--query/);
  await assert.rejects(() => resolvePlace(opts, { query: 'a', placeId: 'b' }), /--query/);
  await assert.rejects(() => resolvePlace(opts, { query: 'a', radius: '10' }), /--radius needs --near/);
  assert.throws(() => parseNear('22.3'), /lat,lng/);
  assert.throws(() => parseNear('95,10'), /lat,lng/);
});

test('resolver parsing fails closed on unexpected shapes', () => {
  assert.equal(parseSearchRows(FX.searchPlaces).length, 3);
  assert.throws(() => parseSearchRows({ success: false, errTypes: ['MissingRequestParamsOrToken'] }), /unexpected response shape/);
  assert.throws(() => parseSearchRows({ success: true, data: [{ placeId: 'x', name: 'n', latitude: '1', longitude: 2 }] }), /row 0 lacks/);
  assert.deepEqual(parseDetails(FX.details[PID.HKG], PID.HKG).name, 'Hong Kong International Airport');
  assert.throws(() => parseDetails(FX.details[PID.HKG], PID.WTS), /asked for/);
  assert.throws(() => parseDetails({ success: true, data: { ...FX.details[PID.HKG].data, geometry: {} } }, PID.HKG), /lacks name, geometry/);
  assert.throws(() => parseDetails({ success: true }, PID.HKG), /unexpected response shape/);
});

// ---------- travel ----------

test('places travel returns Wanderlog\'s seconds per mode', async t => {
  fakeServer(t, baseDoc());
  const out = await placeTravel(opts, { from: PID.WTS, to: PID.HKG });
  assert.deepEqual(out.modes, {
    driving: { seconds: 2045.5, meters: 37719, text: '34 mins' },
    transit: { seconds: 2210, meters: 37475, text: '37 min' },
    walking: { seconds: 28647.6, meters: 40046.8, text: '7 hrs 57 mins' },
  });
  assert.equal(out.from.name, 'Wong Tai Sin');
  await assert.rejects(() => placeTravel(opts, { from: PID.WTS }), /--from <place_id> --to <place_id>/);
  assert.deepEqual(parseDistanceInfo({ success: true, data: { driving: { route: null }, walking: null } }), { driving: null, walking: null });
  assert.throws(() => parseDistanceInfo({ success: true, data: { driving: { route: { duration: {} } } } }), /no route duration/);
  assert.throws(() => parseDistanceInfo({ success: false }), /unexpected response shape/);
});

// The spike S7 trip at version 24: day cards, a hotel card (Mar 1-3) and the legs Wanderlog computed.
function s7Doc() {
  const card = (id, pid, name, travelMode = null) => ({ id, type: 'place', place: place(name, pid, 0, 0), travelMode });
  const day = (id, date, blocks) => ({ id, type: 'normal', mode: 'dayPlan', heading: '', date, blocks });
  return {
    tripPlan: {
      key: TRIP, overallVersion: 24,
      itinerary: {
        sections: [
          { id: 1, type: 'hotels', mode: 'placeList', heading: 'Hotels and lodging', blocks: [{ ...card(731972803, PID.WTS, 'Wong Tai Sin'), hotel: { checkIn: '2027-03-01', checkOut: '2027-03-03' } }] },
          day(94428128, '2027-03-01', [card(11, PID.WTS_D2, 'Wong Tai Sin Station D2'), card(12, PID.HKG, 'Hong Kong International Airport', 'transit'), card(13, PID.TUNG_CHUNG, 'Tung Chung Station')]),
          day(564336919, '2027-03-02', [card(21, PID.WTS_D2, 'Wong Tai Sin Station D2'), { id: 22, type: 'note', text: ops('n') }]),
          day(947364268, '2027-03-03', [card(31, PID.KYOTO, 'Kyoto Station'), card(32, PID.KIX, 'Kansai International Airport', 'walking')]),
        ],
      },
    },
    resources: { distancesBetweenPlaces: FX.s7Distances },
  };
}

test('trips travel lists each day\'s legs: morning lodging, cards, night lodging, with Wanderlog\'s modes and seconds', () => {
  const legs = tripLegs(s7Doc());
  const row = l => `${l.date} ${l.from.block}->${l.to.block} ${l.mode} ${l.seconds === null ? 'null' : Math.round(l.seconds)}`;
  assert.deepEqual(legs.map(row), [
    '2027-03-01 11->12 transit 2164',
    '2027-03-01 12->13 driving 636',
    '2027-03-01 13->731972803 driving 1706',
    '2027-03-02 731972803->21 walking 101',
    '2027-03-02 21->731972803 walking 101',
    '2027-03-03 731972803->31 driving 194190',
    '2027-03-03 31->32 walking null',
  ]);
  assert.equal(legs[0].travelMode, 'transit');
  assert.deepEqual(legs[3].from, { block: 731972803, role: 'lodging', place_id: PID.WTS, name: 'Wong Tai Sin' });
  assert.equal(canon(tripLegs(s7Doc())), canon(legs), 'deterministic');
  assert.deepEqual(tripLegs({ tripPlan: s7Doc().tripPlan }).map(l => l.seconds), [null, null, null, null, null, null, null]);
  assert.throws(() => parseDistances({ distancesBetweenPlaces: { 'not json': {} } }), /distancesBetweenPlaces key/);
  assert.throws(() => parseDistances({ distancesBetweenPlaces: { '["a","b","driving"]': { route: { duration: {} } } } }), /no route duration/);
});

test('travel and resolve flags parse', () => {
  const r = parseArgs(['places', 'resolve', '--query', 'Wong Tai Sin', '--near', '22.34,114.19', '--radius', '2000', '--json']).options;
  assert.deepEqual([r.query, r.near, r.radius], ['Wong Tai Sin', '22.34,114.19', '2000']);
  const t = parseArgs(['places', 'travel', '--from', 'a', '--to', 'b']).options;
  assert.deepEqual([t.from, t.to], ['a', 'b']);
});

test('plan output with native items is deterministic: two runs give the same bytes', async t => {
  fakeServer(t, baseDoc());
  const f = tmpFiles({ desired: desiredDoc({ car: true }), lock: EMPTY_LOCK });
  const a = await runSync({ ...opts, desired: f.desired, last: f.lock }, 'plan', [TRIP]);
  const b = await runSync({ ...opts, desired: f.desired, last: f.lock }, 'plan', [TRIP]);
  assert.equal(a.rawOutput, b.rawOutput);
  assert.equal(a.exitCode, 0);
});
