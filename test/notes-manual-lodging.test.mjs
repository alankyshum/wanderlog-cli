import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandDispatcher } from '../src/commands.mjs';
import { saveToken, TOKEN_VERSION } from '../src/token-store.mjs';
import { setDates } from '../src/trips.mjs';
import { ConcurrentChangeError, ConfirmRequiredError, VerificationError } from '../src/errors.mjs';

test('note writes a verified native block and unmapped lodging is rejected', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-notes-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const trip = { tripPlan: { itinerary: { sections: [{ id: 100, heading: 'Day', type: 'normal', mode: 'dayPlan', blocks: [] }] } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/applyOps')) {
      const { ops } = JSON.parse(init.body);
      for (const op of ops) {
        const index = op.p[2];
        if (op.p.length === 3) trip.tripPlan.itinerary.sections.splice(index, 0, op.li);
        else trip.tripPlan.itinerary.sections[index].blocks.splice(op.p[4], 0, op.li);
      }
      return Response.json({ success: true });
    }
    if (String(url).includes('/api/tripPlans/fixture?')) return Response.json(trip);
    throw new Error('unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await createCommandDispatcher({ configDir, notes: 'UNCONFIRMED flight' }).execute('sections', 'add-note', ['fixture', '100']);
  assert.equal(trip.tripPlan.itinerary.sections[0].blocks[0].text.ops[0].insert, 'UNCONFIRMED flight\n');
  await assert.rejects(() => createCommandDispatcher({ configDir, name: 'Home (Hong Kong)', checkIn: '2026-12-05', checkOut: '2026-12-09' }).execute('lodging', 'add', ['fixture']), /--query is required/);
  await assert.rejects(() => createCommandDispatcher({ configDir, notes: '' }).execute('sections', 'add-note', ['fixture', '100']), /--notes/);
});

// The live server's applyOps, as measured on a sandbox trip (see the header of
// src/budget.mjs): `ld` and `od` are NOT compared with the current value, an
// index past the end and a failed text0 compare refuse the batch, a refused
// batch writes nothing, and a refusal is HTTP 200 { success: false }.
function serverApply(tripPlan, ops) {
  const doc = structuredClone(tripPlan);
  for (const op of ops) {
    const key = op.p.at(-1);
    let parent = doc;
    for (const step of op.p.slice(0, -1)) parent = parent[step];
    if (op.t === 'text0') {
      let text = parent[key];
      for (const c of op.o) {
        if (c.i != null) {
          text = text.slice(0, c.p) + c.i + text.slice(c.p);
        } else {
          const cut = text.slice(c.p, c.p + c.d.length);
          if (cut !== c.d) throw new Error(`Delete component '${c.d}' does not match deleted text '${cut}'`);
          text = text.slice(0, c.p) + text.slice(c.p + c.d.length);
        }
      }
      parent[key] = text;
    } else if ('ld' in op || 'li' in op) {
      if (key >= parent.length + ('ld' in op ? 0 : 1)) throw new Error('Referenced element is out of bounds');
      if ('ld' in op) parent.splice(key, 1);
      if ('li' in op) parent.splice(key, 0, op.li);
    } else if ('oi' in op) {
      parent[key] = op.oi;
    } else {
      throw new Error(`mock server: unsupported op ${JSON.stringify(Object.keys(op))}`);
    }
  }
  return doc;
}

// Mock Wanderlog around serverApply. `hooks.beforeWrite` acts as another
// client between this caller's fetch and the moment its ops are applied.
async function noteHarness(t, trip, hooks = {}) {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-update-note-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const calls = { post: 0, ops: [] };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/applyOps')) {
      calls.post += 1;
      const { ops } = JSON.parse(init.body);
      calls.ops.push(ops);
      if (hooks.postResponse) return hooks.postResponse();
      hooks.beforeWrite?.(trip);
      if (!hooks.dropWrite) {
        try {
          trip.tripPlan = serverApply(trip.tripPlan, ops);
        } catch (err) {
          return Response.json({ success: false, messages: ['Sorry, but we ran into an unexpected error. Please try again later'], errTypes: ['unexpectedError'], error: `Error: message: ${err.message}` });
        }
      }
      hooks.afterWrite?.(trip);
      return Response.json({ success: true });
    }
    if (String(url).includes('/api/tripPlans/fixture?')) return Response.json(trip);
    throw new Error('unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const run = (opts = {}, args = ['fixture', '100', '0']) => createCommandDispatcher({ configDir, notes: 'new', expectedNotes: 'old', confirm: '200', ...opts }).execute('sections', 'update-note', args);
  return { run, calls, hooks };
}

const note = (id, text) => ({ id, type: 'note', text: { ops: [{ insert: `${text}\n` }] }, attachments: [] });
const place = (id, text) => ({ id, type: 'place', place: { name: 'Fixture place' }, text: { ops: [{ insert: `${text}\n` }] } });
const noteTrip = (...blocks) => ({ tripPlan: { itinerary: { sections: [
  { id: 100, heading: 'Day one', type: 'normal', mode: 'dayPlan', date: '2026-01-02', blocks },
  { id: 101, heading: 'Day two', type: 'normal', mode: 'dayPlan', date: '2026-01-03', blocks: [] },
] } } });
const blocksOf = (trip, index = 0) => trip.tripPlan.itinerary.sections[index].blocks;

test('update-note checks ID, exact old plain text and verifies saved result', async t => {
  const trip = noteTrip(note(200, 'old'));
  const { run, calls, hooks } = await noteHarness(t, trip);
  const block = () => blocksOf(trip)[0];
  await assert.rejects(() => run({ confirm: '201' }), /requires --confirm 200/);
  await assert.rejects(() => run({ expectedNotes: 'stale' }), /does not match/);
  block().text.ops[0].attributes = { bold: true };
  await assert.rejects(() => run(), /formatted/);
  delete block().text.ops[0].attributes;
  block().text.ops.push({ insert: 'more\n' });
  await assert.rejects(() => run(), /formatted/);
  block().text.ops.pop();
  block().type = 'place';
  await assert.rejects(() => run(), /not a note/);
  block().type = 'note';
  assert.equal(calls.post, 0);
  hooks.dropWrite = true;
  await assert.rejects(() => run(), err => err instanceof VerificationError && err.exitCode === 7 && /Post-update verification failed/.test(err.message));
  hooks.dropWrite = false;
  const result = await run();
  assert.equal(result.data.blockId, 200);
  assert.deepEqual(block(), note(200, 'new'));
  // The whole write is compares plus one text0 on the note's string: nothing
  // in it can replace or delete an object the server would not check.
  assert.deepEqual(calls.ops.at(-1), [
    { p: ['itinerary', 'sections', 0, 'heading'], t: 'text0', o: [{ p: 0, d: 'Day one' }, { p: 0, i: 'Day one' }] },
    { p: ['itinerary', 'sections', 0, 'date'], t: 'text0', o: [{ p: 0, d: '2026-01-02' }, { p: 0, i: '2026-01-02' }] },
    { p: ['itinerary', 'sections', 0, 'blocks', 0, 'type'], t: 'text0', o: [{ p: 0, d: 'note' }, { p: 0, i: 'note' }] },
    { p: ['itinerary', 'sections', 0, 'blocks', 0, 'text', 'ops', 0, 'insert'], t: 'text0', o: [{ p: 0, d: 'old\n' }, { p: 0, i: 'new\n' }] },
  ]);
});

test('update-note at a stale index is refused by the server with nothing written', async t => {
  const refused = err => err instanceof ConcurrentChangeError && err.exitCode === 8 && /nothing was written/.test(err.message) && /Safe to re-run/.test(err.message);
  // Another client inserts a note in front: the index now holds that note.
  for (const intruder of [note(300, 'phone note'), place(301, 'old'), note(302, 'older text')]) {
    const trip = noteTrip(note(200, 'old'), note(201, 'neighbour'));
    let afterOther;
    const { run, calls } = await noteHarness(t, trip, { beforeWrite: current => { blocksOf(current).unshift(intruder); afterOther = structuredClone(current); } });
    await assert.rejects(() => run(), refused);
    assert.equal(calls.post, 1);
    assert.deepEqual(trip, afterOther);
  }

  // Another client removes the block in front: the index holds the neighbour.
  {
    const trip = noteTrip(note(199, 'first'), note(200, 'old'), note(201, 'neighbour'));
    let afterOther;
    const { run } = await noteHarness(t, trip, { beforeWrite: current => { blocksOf(current).shift(); afterOther = structuredClone(current); } });
    await assert.rejects(() => run({}, ['fixture', '100', '1']), refused);
    assert.deepEqual(trip, afterOther);
  }

  // The note is the last block and another client removes it: nothing there.
  {
    const trip = noteTrip(note(200, 'old'));
    const { run } = await noteHarness(t, trip, { beforeWrite: current => { blocksOf(current).pop(); } });
    await assert.rejects(() => run(), refused);
    assert.deepEqual(blocksOf(trip), []);
  }

  // Another client edits the note itself.
  {
    const trip = noteTrip(note(200, 'old'));
    const { run } = await noteHarness(t, trip, { beforeWrite: current => { blocksOf(current)[0].text.ops[0].insert = 'edited on the phone\n'; } });
    await assert.rejects(() => run(), refused);
    assert.deepEqual(blocksOf(trip), [note(200, 'edited on the phone')]);
  }

  // Another client inserts a section in front: the section index is stale and
  // the block index now points into a section holding an identical note.
  {
    const trip = noteTrip(note(200, 'old'));
    let afterOther;
    const { run } = await noteHarness(t, trip, { beforeWrite: current => {
      current.tripPlan.itinerary.sections.unshift({ id: 99, heading: 'Ideas', type: 'normal', mode: 'placeList', blocks: [note(400, 'old')] });
      afterOther = structuredClone(current);
    } });
    await assert.rejects(() => run(), refused);
    assert.deepEqual(trip, afterOther);
  }
});

test('update-note refuses a note the server could not tell from another block', async t => {
  const trip = noteTrip(note(200, 'old'), note(201, 'old'));
  const { run, calls } = await noteHarness(t, trip);
  await assert.rejects(() => run(), err => err instanceof ConfirmRequiredError && err.exitCode === 5 && /cannot be told apart from block 201/.test(err.message));
  // A longer text with the same beginning also passes a prefix compare.
  blocksOf(trip)[1] = note(201, 'old\nand more');
  await assert.rejects(() => run(), /cannot be told apart from block 201/);
  assert.equal(calls.post, 0);
  // The same text in a section with another heading or date is told apart.
  blocksOf(trip).pop();
  blocksOf(trip, 1).push(note(201, 'old'));
  await run();
  assert.deepEqual(blocksOf(trip), [note(200, 'new')]);
  assert.deepEqual(blocksOf(trip, 1), [note(201, 'old')]);
});

test('update-note reports an uncertain or unverified write as exit 7 and a plain rejection as nothing written', async t => {
  const fiveHundred = await noteHarness(t, noteTrip(note(200, 'old')), { postResponse: () => new Response('oops', { status: 500 }) });
  await assert.rejects(() => fiveHundred.run(), err => err instanceof VerificationError && /uncertain/.test(err.message));
  assert.equal(fiveHundred.calls.post, 1);
  const rejected = await noteHarness(t, noteTrip(note(200, 'old')), { postResponse: () => Response.json({ success: false, errTypes: ['unexpectedError'], error: 'something else' }) });
  await assert.rejects(() => rejected.run(), err => err.exitCode === 1 && /nothing was written/.test(err.message));
  // Accepted, but another client removed the note before the re-fetch.
  const trip = noteTrip(note(200, 'old'));
  const vanished = await noteHarness(t, trip, { afterWrite: current => { blocksOf(current).pop(); } });
  await assert.rejects(() => vanished.run(), err => err instanceof VerificationError && /no longer in the section/.test(err.message));
});

test('recovery requires exact expected old object and repaired trip validation', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-repair-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const place = { name: '🤵‍♂️ Home (Hong Kong)' };
  const trip = { tripPlan: { itinerary: { sections: [{ id: 100, heading: 'Hotels and lodging', type: 'hotels', mode: 'placeList', blocks: [{ id: 200, type: 'place', place, hotel: { checkIn: '2026-12-05', checkOut: '2026-12-09', confirmationNumber: '', travelerNames: [] } }] }] } } };
  let repaired = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('places:searchText')) return Response.json({ places: [{ id: 'fixture-city' }] });
    if (u.includes('/v1/places/fixture-city')) return Response.json({ id: 'fixture-city', displayName: { text: 'Fixture city' }, formattedAddress: 'Fixture city', location: { latitude: 22, longitude: 114 }, types: ['locality'] });
    if (u.endsWith('/applyOps')) {
      const op = JSON.parse(init.body).ops[0];
      assert.deepEqual(op.od, place);
      trip.tripPlan.itinerary.sections[0].blocks[0].place = op.oi;
      repaired = true;
      return Response.json({ success: true });
    }
    if (u.includes('/api/tripPlans/fixture?')) return Response.json(repaired ? trip : { success: false, error: "TypeError: Cannot read properties of undefined (reading 'location')" });
    throw new Error('unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const opts = { configDir, index: 0, name: 'Home (Hong Kong)', query: 'Fixture city', googleKey: 'fixture' };
  await assert.rejects(() => createCommandDispatcher(opts).execute('lodging', 'repair-unmapped', ['fixture']), /requires --confirm/);
  const result = await createCommandDispatcher({ ...opts, confirm: 'fixture' }).execute('lodging', 'repair-unmapped', ['fixture']);
  assert.equal(result.data.recovered, true);
  assert.deepEqual(trip.tripPlan.itinerary.sections[0].blocks[0].place.geometry.location, { lat: 22, lng: 114 });
});

test('aligned dates preserve existing IDs, move explicit dates, append days and reject shrinking', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-dates-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const trip = { tripPlan: { startDate: '2027-01-04', endDate: '2027-01-05', itinerary: { sections: [
    { id: 100, heading: '', type: 'normal', mode: 'dayPlan', date: '2027-01-04', blocks: [] },
    { id: 101, heading: '', type: 'normal', mode: 'dayPlan', date: '2027-01-05', blocks: [] },
  ] } } };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/applyOps')) {
      for (const op of JSON.parse(init.body).ops) {
        if (op.p.length === 1) trip.tripPlan[op.p[0]] = op.oi;
        else if (op.p.length === 4) trip.tripPlan.itinerary.sections[op.p[2]][op.p[3]] = op.oi;
        else trip.tripPlan.itinerary.sections.splice(op.p[2], 0, op.li);
      }
      return Response.json({ success: true });
    }
    if (String(url).includes('/api/tripPlans/fixture?')) return Response.json(trip);
    throw new Error('unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await setDates({ configDir }, 'fixture', '2026-12-03', '2026-12-05', { alignDaySections: true });
  assert.deepEqual(trip.tripPlan.itinerary.sections.map(s => s.date), ['2026-12-03', '2026-12-04', '2026-12-05']);
  assert.deepEqual(trip.tripPlan.itinerary.sections.slice(0, 2).map(s => s.id), [100, 101]);
  await assert.rejects(() => setDates({ configDir }, 'fixture', '2026-12-03', '2026-12-04', { alignDaySections: true }), /Refusing to remove/);
  trip.tripPlan.itinerary.sections[1].date = '2027-01-01';
  await assert.rejects(() => setDates({ configDir }, 'fixture', '2026-12-03', '2026-12-06', { alignDaySections: true }), /do not align/);
});
