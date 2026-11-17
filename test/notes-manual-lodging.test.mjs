import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCommandDispatcher } from '../src/commands.mjs';
import { saveToken, TOKEN_VERSION } from '../src/token-store.mjs';
import { setDates } from '../src/trips.mjs';

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

test('update-note checks ID, exact old plain text and verifies saved result', async t => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wlog-update-note-test-'));
  t.after(() => fs.rm(configDir, { recursive: true, force: true }));
  await saveToken({ configDir }, { version: TOKEN_VERSION, baseUrl: 'https://example.test', userId: 'fixture', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', cookies: [{ name: 'connect.sid', value: 'FAKE', domain: 'example.test', path: '/' }] });
  const block = { id: 200, type: 'note', text: { ops: [{ insert: 'old\n' }] }, attachments: [] };
  const trip = { tripPlan: { itinerary: { sections: [{ id: 100, type: 'normal', mode: 'dayPlan', blocks: [block] }] } } };
  let writes = 0, ignore = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/applyOps')) {
      writes++;
      const op = JSON.parse(init.body).ops[0];
      assert.deepEqual(op.od, block.text);
      if (!ignore) block.text = op.oi;
      return Response.json({ success: true });
    }
    if (String(url).includes('/api/tripPlans/fixture?')) return Response.json(trip);
    throw new Error('unexpected network request');
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const run = opts => createCommandDispatcher({ configDir, notes: 'new', expectedNotes: 'old', ...opts }).execute('sections', 'update-note', ['fixture', '100', '0']);
  await assert.rejects(() => run({ confirm: '201' }), /requires --confirm 200/);
  await assert.rejects(() => run({ confirm: '200', expectedNotes: 'stale' }), /does not match/);
  block.text.ops[0].attributes = { bold: true };
  await assert.rejects(() => run({ confirm: '200' }), /formatted/);
  delete block.text.ops[0].attributes;
  block.type = 'place';
  await assert.rejects(() => run({ confirm: '200' }), /not a note/);
  block.type = 'note';
  assert.equal(writes, 0);
  ignore = true;
  await assert.rejects(() => run({ confirm: '200' }), /Post-update verification failed/);
  ignore = false;
  const result = await run({ confirm: '200' });
  assert.equal(result.data.blockId, 200);
  assert.deepEqual(block.text, { ops: [{ insert: 'new\n' }] });
  assert.deepEqual(block.attachments, []);
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
