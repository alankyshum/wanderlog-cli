import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EXIT, SyncExit, analyse, applyJson0, assertBatchSchema, buildApplyBatch, canon, checkBlockSchema, nativeBlock,
  normOps, redactTripDoc, stableJson, writeBlock,
} from '../src/sync.mjs';
import { runSync, syncApply, syncPlan, syncRestore, fetchRedacted } from '../src/sync-cli.mjs';
import { validateTripPlanStructure } from '../src/validation.mjs';
import { parseArgs } from '../bin/args.mjs';
import { createCommandDispatcher } from '../src/commands.mjs';
import { resolvePlace } from '../src/places.mjs';
import { deleteTrip } from '../src/trips.mjs';

const FIX = new URL('./fixtures/sync/', import.meta.url);
const load = name => JSON.parse(readFileSync(new URL(name, FIX), 'utf8'));
const V = load('vectors.json');
const DESIRED = load('desired-alpha.json');
const LOCK = load('lock-alpha.json');
const TRIP = 'alphatripkey0001';
const SECRETS = ['EDITSECRET01', 'VIEWSECRET01', 'SUGGESTSECRET01', 'JOURNALSECRET01', 'TPKSECRET01', 'TPKSECRET02'];
const opts = { cookies: [{ name: 'connect.sid', value: 'FAKEVALUE' }] };
const clone = v => structuredClone(v);

function tmp() {
  return mkdtempSync(join(tmpdir(), 'wlog-sync-test-'));
}

function files(dir, map) {
  const out = {};
  for (const [name, value] of Object.entries(map)) {
    out[name] = join(dir, `${name}.json`);
    writeFileSync(out[name], JSON.stringify(value));
  }
  return out;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// In-memory Wanderlog: GET returns the trip, POST applyOps applies the json0 batch (refusing it
// whole on a failed compare, as the server does) and raises overallVersion by one.
function fakeServer(t, doc, hooks = {}) {
  const state = { doc: clone(doc), posts: [], gets: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (init.method === 'POST' && u.pathname === `/api/tripPlans/${TRIP}/applyOps`) {
      const { ops } = JSON.parse(init.body);
      state.posts.push(ops);
      hooks.beforePost?.(state);
      if (hooks.networkError) throw new Error('socket hang up');
      const next = clone(state.doc);
      try {
        applyJson0(next.tripPlan, ops);
      } catch (err) {
        return json({ success: false, error: err.message });
      }
      next.tripPlan.overallVersion += hooks.versionStep ?? 1;
      hooks.afterPost?.(next);
      state.doc = next;
      return json({ success: true });
    }
    if (init.method === 'GET' && u.pathname === `/api/tripPlans/${TRIP}`) {
      state.gets += 1;
      if (hooks.failGet) return json({ success: false, errTypes: ['tripPlanNotFound'] });
      return json(clone(state.doc));
    }
    return json({ error: 'not found' }, 404);
  };
  t.after(() => { globalThis.fetch = original; });
  return state;
}

const withoutMeta = result => {
  const { desired, resolved, ...rest } = result;
  return rest;
};
const docOf = name => V.docs[name];
const desiredOf = name => (name === true ? DESIRED : name === 'desired2' ? V.desired2 : null);
const lockOf = name => (name === 'lock' ? LOCK : name === 'lock2' ? V.lock2 : null);

// ---------- parity with the vault's reference (fake_sync_wlog.py) ----------

for (const [name, vector] of Object.entries(V.vectors)) {
  test(`reference vector ${name}: ops, drift, fingerprints, refusals and hashes match`, () => {
    let desired = desiredOf(vector.desired);
    if (name === 'verify_after_apply') {
      desired = clone(DESIRED);
      for (const s of desired.sections) s.new = false;
    }
    const got = withoutMeta(analyse(docOf(vector.doc), desired, lockOf(vector.lock)));
    if (name === 'verify_after_apply') {
      // Blocks that already sit in Wanderlog under their own id are landed writes, not matches.
      const moved = Object.fromEntries(Object.entries(vector.expected.matched).filter(([key, m]) => {
        const block = desired.sections.flatMap(s => s.blocks).find(b => b.key === key);
        return block.id !== m.id;
      }));
      assert.deepEqual(got.matched, moved);
      assert.equal(canon({ ...got, matched: null }), canon({ ...vector.expected, matched: null }));
    } else {
      assert.equal(canon(got), canon(vector.expected));
    }
  });
}

test('plan output is deterministic: two runs on one snapshot give the same bytes', async () => {
  const dir = tmp();
  const f = files(dir, { snap: docOf('edited'), desired: V.desired2, lock: V.lock2 });
  const run = async () => (await runSync({ snapshot: f.snap, desired: f.desired, last: f.lock }, 'plan', [TRIP])).rawOutput;
  const a = await run();
  const b = await run();
  assert.equal(a, b);
  const parsed = JSON.parse(a);
  assert.equal(parsed.op_count, V.vectors.drift_plan.expected.op_count);
  assert.equal(parsed.drift.length, 8);
});

test('plan with --snapshot writes the drift report and exits 3 on refusals with the result on stdout', async () => {
  const dir = tmp();
  const f = files(dir, { snap: docOf('refuse_wiped'), desired: V.desired2, lock: V.lock2 });
  const report = join(dir, 'report.json');
  const result = await runSync({ snapshot: f.snap, desired: f.desired, last: f.lock, outReport: report }, 'plan', [TRIP]);
  assert.equal(result.exitCode, EXIT.refused);
  const out = JSON.parse(result.rawOutput);
  assert.match(out.refusals[0], /mapped blocks are missing/);
  const written = JSON.parse(readFileSync(report, 'utf8'));
  assert.equal(written.trip, TRIP);
  assert.equal(written.snapshot, null);
  assert.deepEqual(written.drift, out.drift);
  assert.equal(statSync(report).mode & 0o777, 0o600);
});

test('plan refuses a snapshot of another trip', async () => {
  const dir = tmp();
  const f = files(dir, { snap: docOf('after'), desired: V.desired2, lock: V.lock2 });
  const result = await runSync({ snapshot: f.snap, desired: f.desired, last: f.lock }, 'plan', ['someothertrip000']);
  assert.equal(result.exitCode, EXIT.refused);
  assert.match(JSON.parse(result.rawOutput).refusals.join(' '), /differs from someothertrip000/);
});

test('bad inputs exit 2 with a JSON error', async () => {
  const dir = tmp();
  const f = files(dir, { bad: { desired_version: 2, sections: [] }, lock: { lock_version: 9 } });
  for (const [sub, o] of [
    ['plan', { snapshot: f.bad }],
    ['plan', { snapshot: join(dir, 'missing.json') }],
    ['apply', { desired: f.bad, expectVersion: '1' }],
    ['apply', { desired: join(dir, 'missing.json') }],
    ['restore', { fromSnapshot: f.bad }],
    ['nope', {}],
  ]) {
    const result = await runSync(o, sub, [TRIP]);
    assert.equal(result.exitCode, EXIT.usage, `${sub} ${JSON.stringify(o)}`);
    assert.equal(JSON.parse(result.rawOutput).exit, 2);
  }
});

// ---------- apply ----------

test('apply posts one guarded batch, verifies, and a second apply writes 0 ops', async t => {
  const server = fakeServer(t, docOf('base'));
  const dir = tmp();
  const f = files(dir, { desired: DESIRED, lock: LOCK, ack: { trip: TRIP, drift: V.vectors.first_plan.expected.drift } });
  const snapshot = join(dir, 'post.json');
  const first = await syncApply({ ...opts, desired: f.desired, last: f.lock, expectVersion: '100', ackDrift: f.ack, outSnapshot: snapshot }, TRIP);
  assert.equal(first.exitCode, 0);
  assert.equal(server.posts.length, 1);
  const out = first.output;
  assert.equal(out.version_before, 100);
  assert.equal(out.version_after, 101);
  assert.equal(out.verified, true);
  assert.equal(out.ops_applied, 7);
  assert.deepEqual(out.matched, { 'ribeira-walk': { id: 555000001 } });
  assert.deepEqual(out.hashes, V.vectors.verify_after_apply.expected.hashes, 'same normal form as the reference after its apply');

  // The batch: compares first, then writes; each touched section gets heading + block identity compares.
  const batch = server.posts[0];
  const firstWrite = batch.findIndex(c => c.t !== 'text0');
  assert.ok(firstWrite > 0);
  assert.ok(batch.slice(firstWrite).every(c => c.t !== 'text0'));
  assert.ok(batch.some(c => c.t === 'text0' && canon(c.p) === canon(['itinerary', 'sections', 4, 'blocks', 0, 'place', 'name'])));
  assert.ok(batch.some(c => c.t === 'text0' && canon(c.p) === canon(['itinerary', 'sections', 4, 'date'])));
  assert.ok(batch.some(c => c.li && c.li.id === 467721092), 'new list inserted');

  // Native field set on new blocks; unmodelled fields carried on existing ones; other sections untouched.
  const sections = server.doc.tripPlan.itinerary.sections;
  assert.deepEqual(sections.map(s => s.id), [200000001, 200000002, 200000099, 200000003, 467721092, 200000011, 200000012]);
  const before = new Set(docOf('base').tripPlan.itinerary.sections.flatMap(s => s.blocks).map(canon));
  const written = sections.flatMap(s => s.blocks).filter(b => !before.has(canon(b)));
  assert.equal(written.length, 13); // 9 new (ribeira was matched) + 4 changed existing
  for (const block of written) assert.deepEqual(checkBlockSchema(block), [], `block ${block.id}`);
  const pastry = sections[5].blocks.find(b => b.id === 913960813);
  assert.deepEqual(pastry.addedBy, { type: 'user', userId: 4242 });
  assert.deepEqual(pastry.imageKeys, []);
  assert.equal(pastry.place.place_id, null);
  const inn = sections[1].blocks[0];
  assert.deepEqual(inn.hotel.travelerNames, ['Traveller A']);
  assert.deepEqual(inn.imageKeys, ['img-1']);
  assert.equal(inn.place.rating, undefined, 'the Google place id changed, so the old Google fields are dropped');
  assert.equal(inn.place.place_id, 'synthetic-place-a5');
  assert.deepEqual(sections[2], docOf('base').tripPlan.itinerary.sections[2]);
  const flat = sections[1].blocks[1];
  assert.deepEqual(flat.hotel, { checkIn: '2027-05-12', checkOut: '2027-05-13', confirmationNumber: '', travelerNames: [] });
  assert.equal(validateTripPlanStructure(server.doc).valid, true);

  const post = readFileSync(snapshot, 'utf8');
  assert.equal(statSync(snapshot).mode & 0o777, 0o600);
  for (const secret of SECRETS) assert.ok(!post.includes(secret), secret);

  // Second run with the lock the vault writes after a verified push: nothing to do, no post.
  const g = files(dir, { desired2: V.desired2, lock2: { ...V.lock2, section_hashes: out.hashes.sections } });
  const planned = await syncPlan({ ...opts, desired: g.desired2, last: g.lock2 }, TRIP);
  assert.equal(planned.output.op_count, 0);
  assert.deepEqual(planned.output.drift, []);
  const second = await syncApply({ ...opts, desired: g.desired2, last: g.lock2, expectVersion: '101' }, TRIP);
  assert.equal(second.exitCode, 0);
  assert.equal(second.output.ops_applied, 0);
  assert.equal(second.output.version_after, 101);
  assert.equal(server.posts.length, 1);
});

test('apply exits 8 when overallVersion moved since plan, and writes nothing', async t => {
  const server = fakeServer(t, docOf('after'));
  const f = files(tmp(), { desired: V.desired2, lock: V.lock2 });
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '100' }, 'apply', [TRIP]);
  assert.equal(result.exitCode, EXIT.version);
  assert.deepEqual(JSON.parse(result.rawOutput).found, 101);
  assert.equal(server.posts.length, 0);
});

test('apply exits 10 on drift missing from --ack-drift, and proceeds once every fingerprint is acknowledged', async t => {
  const server = fakeServer(t, docOf('edited'));
  const dir = tmp();
  const drift = V.vectors.drift_plan.expected.drift;
  const f = files(dir, { desired: V.desired2, lock: V.lock2, partial: { trip: TRIP, drift: drift.slice(1) }, full: { trip: TRIP, drift } });
  const version = String(docOf('edited').tripPlan.overallVersion);
  for (const ack of [undefined, f.partial]) {
    const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: version, ackDrift: ack }, 'apply', [TRIP]);
    assert.equal(result.exitCode, EXIT.drift);
    const out = JSON.parse(result.rawOutput);
    assert.ok(out.unacknowledged.length >= 1);
  }
  assert.equal(server.posts.length, 0);
  const done = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: version, ackDrift: f.full }, 'apply', [TRIP]);
  assert.equal(done.exitCode, 0, done.rawOutput);
  assert.equal(server.posts.length, 1);
  // The file wins: the app-added note is gone, the edited text is back, ribeira is re-created.
  const after = analyse(server.doc, V.desired2, V.lock2);
  assert.equal(after.op_count, 0);
});

test('apply exits 3 on each structural refusal and writes nothing', async t => {
  for (const name of ['duplicate', 'missing_section', 'moved_day', 'wiped', 'unknown_type', 'extra_day']) {
    const doc = docOf(`refuse_${name}`);
    const server = fakeServer(t, doc);
    const f = files(tmp(), { desired: V.desired2, lock: V.lock2 });
    const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: String(doc.tripPlan.overallVersion) }, 'apply', [TRIP]);
    assert.equal(result.exitCode, EXIT.refused, name);
    assert.deepEqual(JSON.parse(result.rawOutput).refusals, V.vectors[`refuse_${name}`].expected.refusals);
    assert.equal(server.posts.length, 0);
  }
});

test('apply exits 5 when a server-side compare fails (an app edit between fetch and post)', async t => {
  const server = fakeServer(t, docOf('base'), {
    beforePost: state => { state.doc.tripPlan.itinerary.sections[4].blocks[0].place.name = 'Renamed on the phone'; },
  });
  const f = files(tmp(), { desired: DESIRED, lock: LOCK, ack: { drift: V.vectors.first_plan.expected.drift } });
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '100', ackDrift: f.ack }, 'apply', [TRIP]);
  assert.equal(result.exitCode, EXIT.guard);
  assert.equal(server.doc.tripPlan.overallVersion, 100, 'nothing written');
});

test('apply exits 7 on an uncertain write, a verify mismatch and a version jump; never retried', async t => {
  const cases = [
    { networkError: true },
    { afterPost: next => { next.tripPlan.itinerary.sections[1].heading = 'Changed by the server'; } },
    { afterPost: next => { next.tripPlan.itinerary.sections[5].blocks[0].text = { ops: [{ insert: 'rewritten\n' }] }; } },
    { versionStep: 2 },
  ];
  for (const hooks of cases) {
    const server = fakeServer(t, docOf('base'), hooks);
    const dir = tmp();
    const f = files(dir, { desired: DESIRED, lock: LOCK, ack: { drift: V.vectors.first_plan.expected.drift } });
    const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '100', ackDrift: f.ack, outSnapshot: join(dir, 'post.json') }, 'apply', [TRIP]);
    assert.equal(result.exitCode, EXIT.uncertain, JSON.stringify(Object.keys(hooks)));
    assert.equal(server.posts.length, 1);
  }
});

test('fetch failures exit 4', async t => {
  fakeServer(t, docOf('base'), { failGet: true });
  const f = files(tmp(), { desired: DESIRED });
  const result = await runSync({ ...opts, desired: f.desired, expectVersion: '100' }, 'apply', [TRIP]);
  assert.equal(result.exitCode, EXIT.fetch);
  assert.match(JSON.parse(result.rawOutput).error.message, /tripPlanNotFound/);
  const planned = await runSync({ ...opts }, 'plan', [TRIP]);
  assert.equal(planned.exitCode, EXIT.fetch);
});

test('a plan-invalid capture (no --desired) reports every changed key with field *', async t => {
  fakeServer(t, docOf('edited'));
  const f = files(tmp(), { lock: V.lock2 });
  const result = await syncPlan({ ...opts, last: f.lock }, TRIP);
  assert.deepEqual(result.output.drift, V.vectors.drift_no_desired.expected.drift);
  assert.equal(result.output.op_count, 0);
});

// ---------- section resolution, landed writes, deletes ----------

test('existing day, Notes and Hotels sections with id null resolve by date and type', () => {
  const desired = clone(V.desired2);
  for (const s of desired.sections) if (!s.key.startsWith('list:ideas') && !s.key.startsWith('list:admin')) s.id = null;
  const lock = { lock_version: 1, sections: {}, entries: {} };
  const result = analyse(docOf('after'), desired, lock);
  assert.deepEqual(result.refusals, []);
  assert.deepEqual(result.resolved, { 'day:2027-05-11': 200000011, 'day:2027-05-12': 200000012, 'list:hotels': 200000002, 'list:notes': 200000001 });
  assert.equal(result.op_count, 0);
});

test('an ambiguous or missing section is refused, never guessed', () => {
  const doc = clone(docOf('after'));
  doc.tripPlan.itinerary.sections.push({ ...clone(doc.tripPlan.itinerary.sections[0]), id: 200000098 });
  const desired = clone(V.desired2);
  desired.sections.find(s => s.key === 'list:notes').id = null;
  const result = analyse(doc, desired, null);
  assert.ok(result.refusals.includes('desired section list:notes matches 2 Wanderlog sections'));
  assert.ok(result.refusals.includes('desired section list:notes has no Wanderlog id'));
});

// A trip with no Hotels section in Wanderlog, and a plan that adds a kind: hotels list (UAT D2).
function withoutHotels() {
  const doc = clone(docOf('after'));
  doc.tripPlan.itinerary.sections = doc.tripPlan.itinerary.sections.filter(s => s.type !== 'hotels');
  const desired = clone(V.desired2);
  const hotels = desired.sections.find(s => s.key === 'list:hotels');
  hotels.id = 300000777;
  hotels.new = true;
  hotels.blocks.forEach((b, i) => { b.id = 300000780 + i; b.new = true; });
  const lock = clone(V.lock2);
  delete lock.sections['list:hotels'];
  delete lock.section_hashes['list:hotels'];
  for (const b of hotels.blocks) delete lock.entries[b.key];
  return { doc, desired, lock };
}

test('a new Hotels section is created natively after Notes when Wanderlog has none', async t => {
  const { doc, desired, lock } = withoutHotels();
  const found = analyse(doc, desired, lock);
  assert.deepEqual(found.refusals, []);
  assert.deepEqual(found.drift, []);
  assert.deepEqual(found.ops, [{ op: 'insert_section', section: 'list:hotels', blocks: ['harbour-inn-stay', 'old-town-flat-stay'] }]);

  const server = fakeServer(t, doc);
  const f = files(tmp(), { desired, lock });
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: String(doc.tripPlan.overallVersion) }, 'apply', [TRIP]);
  assert.equal(result.exitCode, 0, result.rawOutput);
  const out = JSON.parse(result.rawOutput);
  assert.equal(out.ops_applied, 1);
  assert.equal(out.verified, true);
  const sections = server.doc.tripPlan.itinerary.sections;
  assert.deepEqual(sections.map(s => s.id), [200000001, 300000777, 200000099, 200000003, 467721092, 200000011, 200000012]);
  const { blocks, ...shape } = sections[1];
  assert.deepEqual(shape, {
    id: 300000777, heading: 'Hotels and lodging', type: 'hotels', mode: 'placeList',
    text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#e67e22', placeMarkerIcon: 'bed',
  });
  assert.deepEqual(blocks.map(b => b.id), [300000780, 300000781]);
  for (const block of blocks) assert.deepEqual(checkBlockSchema(block), [], `block ${block.id}`);
  assert.equal(validateTripPlanStructure(server.doc).valid, true);
  assert.equal(analyse(server.doc, { ...desired, sections: desired.sections.map(s => ({ ...s, new: false, blocks: s.blocks.map(b => ({ ...b, new: false })) })) },
    { ...lock, sections: { ...lock.sections, 'list:hotels': 300000777 } }).op_count, 0);
});

test('a new Hotels section takes the one existing Hotels section; two are refused', () => {
  const { desired, lock } = withoutHotels();
  const found = analyse(docOf('after'), desired, lock);
  assert.deepEqual(found.resolved, { 'list:hotels': 200000002 });
  assert.ok(!found.ops.some(o => o.op === 'insert_section'));
  const two = clone(docOf('after'));
  two.tripPlan.itinerary.sections.splice(1, 0, { ...clone(two.tripPlan.itinerary.sections[1]), id: 200000098, blocks: [] });
  assert.ok(analyse(two, desired, lock).refusals.includes('desired section list:hotels matches 2 Wanderlog sections'));
});

test('a new block whose id already landed in its section is not written again; an id used elsewhere is refused', () => {
  const desired = clone(DESIRED);
  for (const s of desired.sections) s.new = false;
  const landed = analyse(docOf('after'), desired, LOCK);
  assert.equal(landed.op_count, 0);
  const collide = clone(DESIRED);
  collide.sections.find(s => s.key === 'day:2027-05-11').blocks.find(b => b.key === 'alfama-viewpoint').id = 300000099;
  assert.ok(analyse(docOf('base'), collide, LOCK).refusals.includes('new block alfama-viewpoint id 300000099 is already used in Wanderlog'));
});

test('a locked list section dropped from desired is deleted; a day section is never deleted', async t => {
  const desired = clone(V.desired2);
  desired.sections = desired.sections.filter(s => s.key !== 'list:ideas');
  const found = analyse(docOf('after'), desired, V.lock2);
  assert.deepEqual(found.ops, [{ op: 'delete_section', section: 'list:ideas' }]);
  const { components } = buildApplyBatch(docOf('after'), found.desired, V.lock2);
  assert.deepEqual(components.at(-1), { p: ['itinerary', 'sections', 4], ld: docOf('after').tripPlan.itinerary.sections[4] });
  assert.ok(components.some(c => c.t === 'text0' && canon(c.p) === canon(['itinerary', 'sections', 4, 'heading'])));

  const noDay = clone(V.lock2);
  noDay.sections['day:2027-05-99'] = 200000012;
  assert.throws(() => buildApplyBatch(docOf('after'), found.desired, noDay), err => err instanceof SyncExit && err.exitCode === EXIT.refused);

  const server = fakeServer(t, docOf('after'));
  const f = files(tmp(), { desired, lock: V.lock2 });
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '101' }, 'apply', [TRIP]);
  assert.equal(result.exitCode, 0, result.rawOutput);
  assert.ok(!server.doc.tripPlan.itinerary.sections.some(s => s.id === 467721092));
});

// ---------- required block fields ----------

test('builders give every new block the native field set', () => {
  const owner = 4242;
  const place = writeBlock({ id: 1, type: 'place', place: { name: 'P', formatted_address: 'A', geometry: { location: { lat: 1, lng: 2 } } }, text: { ops: [{ insert: 'x\n' }] }, startTime: '09:00' }, undefined, owner);
  assert.deepEqual(Object.keys(place).sort(), ['addedBy', 'attachments', 'id', 'imageKeys', 'imageSize', 'place', 'startTime', 'text', 'travelMode', 'type', 'upvotedBy']);
  assert.deepEqual(checkBlockSchema(place), []);
  const note = writeBlock({ id: 2, type: 'note', text: { ops: [{ insert: 'n\n' }] } }, undefined, owner);
  assert.deepEqual(Object.keys(note).sort(), ['addedBy', 'attachments', 'id', 'text', 'type']);
  const list = writeBlock({ id: 3, type: 'checklist', title: 'T', items: [{ id: 4, checked: false, text: { ops: [{ insert: 'r\n' }] } }] }, undefined, owner);
  assert.deepEqual(Object.keys(list).sort(), ['addedBy', 'attachments', 'id', 'items', 'title', 'type']);
  assert.deepEqual(checkBlockSchema(list), []);
  const old = { id: 5, type: 'place', place: { name: 'Old', place_id: null, geometry: { location: { lat: 1, lng: 1 } }, formatted_address: '', types: ['point_of_interest'] }, text: { ops: [{ insert: 'o\n' }] }, addedBy: { type: 'user', userId: 9 }, imageSize: 'small', upvotedBy: [], travelMode: null, attachments: [], startTime: null, endTime: null };
  const rewritten = writeBlock({ id: 5, type: 'place', place: { name: 'New', formatted_address: '', geometry: { location: { lat: 1, lng: 1 } } }, text: { ops: [{ insert: 'n\n' }] } }, old, owner);
  assert.deepEqual(rewritten.imageKeys, [], 'an old CLI block gets the field it lacked');
  assert.deepEqual(rewritten.addedBy, { type: 'user', userId: 9 }, 'present values kept');
  assert.equal(rewritten.startTime, null);
  const google = { ...old, place: { ...old.place, place_id: 'g1', rating: 4.1, photo_urls: ['u'] }, upvotedBy: [7], imageKeys: ['k'] };
  const kept = writeBlock({ id: 5, type: 'place', place: { name: 'Renamed', formatted_address: 'Addr', place_id: 'g1', geometry: { location: { lat: 2, lng: 3 } } }, text: { ops: [{ insert: 't\n' }] } }, google, owner);
  assert.deepEqual([kept.place.rating, kept.place.photo_urls, kept.upvotedBy, kept.imageKeys, kept.place.name, kept.place.geometry.location], [4.1, ['u'], [7], ['k'], 'Renamed', { lat: 2, lng: 3 }]);
});

test('the pre-post schema check refuses a batch whose new or replaced block misses any required field', () => {
  const owner = 4242;
  const good = {
    place: writeBlock({ id: 11, type: 'place', place: { name: 'P', formatted_address: 'A', place_id: 'g', geometry: { location: { lat: 1, lng: 2 } } }, text: { ops: [{ insert: 'x\n' }] } }, undefined, owner),
    note: writeBlock({ id: 12, type: 'note', text: { ops: [{ insert: 'n\n' }] } }, undefined, owner),
    checklist: writeBlock({ id: 13, type: 'checklist', title: 'T', items: [{ id: 14, checked: true, text: { ops: [{ insert: 'r\n' }] } }] }, undefined, owner),
  };
  const required = {
    place: ['id', 'type', 'addedBy', 'attachments', 'place', 'text', 'imageSize', 'upvotedBy', 'travelMode', 'imageKeys'],
    note: ['id', 'type', 'addedBy', 'attachments', 'text'],
    checklist: ['id', 'type', 'addedBy', 'attachments', 'title', 'items'],
  };
  const path = ['itinerary', 'sections', 0, 'blocks'];
  for (const [type, block] of Object.entries(good)) {
    assert.doesNotThrow(() => assertBatchSchema([{ p: path, od: [], oi: [block] }], []));
    for (const field of required[type]) {
      const broken = clone(block);
      delete broken[field];
      assert.throws(() => assertBatchSchema([{ p: path, od: [], oi: [broken] }], []), err => err.exitCode === EXIT.refused && /lacks/.test(err.message), `${type} without ${field}`);
      assert.throws(() => assertBatchSchema([{ p: ['itinerary', 'sections', 0], li: { id: 1, blocks: [broken] } }], []), err => err.exitCode === EXIT.refused);
    }
  }
  for (const field of ['name', 'geometry', 'formatted_address', 'place_id', 'types']) {
    const broken = clone(good.place);
    delete broken.place[field];
    assert.throws(() => assertBatchSchema([{ p: path, od: [], oi: [broken] }], []), err => err.exitCode === EXIT.refused, `place.${field}`);
  }
  const thin = { id: 15, type: 'place', place: good.place.place, text: good.place.text };
  assert.throws(() => assertBatchSchema([{ p: path, od: [], oi: [thin] }], []), /lacks addedBy, attachments, imageSize, upvotedBy, travelMode, imageKeys/);
  // A block already in Wanderlog, carried byte-identical, is not judged by the new-block rule.
  assert.doesNotThrow(() => assertBatchSchema([{ p: path, od: [thin], oi: [thin] }], [thin]));
  assert.deepEqual(nativeBlock({ id: 1, type: 'note' }, owner), { id: 1, type: 'note', addedBy: { type: 'user', userId: owner }, attachments: [] });
});

test('a rewritten block keeps a digit-string addedBy.userId (older CLI blocks) and passes the schema check', () => {
  const owner = 4242;
  const path = ['itinerary', 'sections', 0, 'blocks'];
  const old = { id: 21, type: 'note', text: { ops: [{ insert: 'old\n' }] }, addedBy: { type: 'user', userId: '1144884' }, attachments: [] };
  const rewritten = writeBlock({ id: 21, type: 'note', text: { ops: [{ insert: 'new\n' }] } }, old, owner);
  assert.deepEqual(rewritten.addedBy, { type: 'user', userId: '1144884' }, 'existing addedBy is never rewritten');
  assert.deepEqual(checkBlockSchema(rewritten), []);
  assert.doesNotThrow(() => assertBatchSchema([{ p: path, od: [old], oi: [rewritten] }], [old]));
  const oldPlace = { id: 22, type: 'place', place: { name: 'Old', place_id: null, geometry: { location: { lat: 1, lng: 1 } }, formatted_address: '', types: ['point_of_interest'] }, text: { ops: [{ insert: 'o\n' }] }, addedBy: { type: 'user', userId: '9' }, imageSize: 'small', upvotedBy: [], travelMode: null, attachments: [], imageKeys: [] };
  const place = writeBlock({ id: 22, type: 'place', place: { name: 'New', formatted_address: '', geometry: { location: { lat: 1, lng: 1 } } }, text: { ops: [{ insert: 'n\n' }] } }, oldPlace, owner);
  assert.deepEqual(place.addedBy, { type: 'user', userId: '9' });
  assert.doesNotThrow(() => assertBatchSchema([{ p: path, od: [oldPlace], oi: [place] }], [oldPlace]));
  // New blocks keep the native (web-created) shape: a number.
  assert.equal(typeof writeBlock({ id: 23, type: 'note', text: { ops: [{ insert: 'n\n' }] } }, undefined, owner).addedBy.userId, 'number');
  for (const userId of ['12a', '', ' 12', '-1', '1.5', null, undefined, 1.5, {}]) {
    const bad = { ...rewritten, addedBy: { type: 'user', userId } };
    if (userId === undefined) delete bad.addedBy.userId;
    assert.deepEqual(checkBlockSchema(bad), ['addedBy'], `userId ${JSON.stringify(userId)}`);
    assert.throws(() => assertBatchSchema([{ p: path, od: [], oi: [bad] }], []), err => err.exitCode === EXIT.refused && /lacks addedBy/.test(err.message));
  }
  for (const addedBy of [null, undefined, 'user', { userId: 9 }]) {
    const bad = { ...rewritten, addedBy };
    if (addedBy === undefined) delete bad.addedBy;
    assert.deepEqual(checkBlockSchema(bad), ['addedBy']);
  }
});

test('apply refuses (exit 3, no post) when a desired block would be written incomplete', async t => {
  const server = fakeServer(t, docOf('after'));
  const doc = clone(docOf('after'));
  delete doc.tripPlan.userId;
  server.doc = doc;
  const desired = clone(V.desired2);
  desired.sections.find(s => s.key === 'day:2027-05-12').blocks.push({ id: 123456789, key: 'x', new: true, type: 'note', text: { ops: [{ insert: 'x\n' }] } });
  const f = files(tmp(), { desired, lock: V.lock2 });
  const result = await runSync({ ...opts, desired: f.desired, last: f.lock, expectVersion: '101' }, 'apply', [TRIP]);
  assert.equal(result.exitCode, EXIT.refused);
  assert.match(JSON.parse(result.rawOutput).error.message, /userId/);
  assert.equal(server.posts.length, 0);
});

// ---------- restore ----------

test('restore puts managed sections back from a snapshot and removes an inserted list', async t => {
  const server = fakeServer(t, docOf('after'));
  const dir = tmp();
  const f = files(dir, { pre: redactTripDoc(docOf('base')), last: V.lock2, target: LOCK, ack: { drift: [] } });
  const result = await syncRestore({ ...opts, fromSnapshot: f.pre, last: f.last, targetLock: f.target, expectVersion: '101' }, TRIP);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output.verified, true);
  assert.equal(result.output.version_after, 102);
  const now = server.doc.tripPlan.itinerary.sections;
  const base = docOf('base').tripPlan.itinerary.sections;
  assert.deepEqual(now, base, 'raw sections byte-equal to the snapshot');
  assert.equal(server.doc.tripPlan.editKey, 'EDITSECRET01', 'restore never writes trip-level fields');
  assert.ok(server.posts[0].every(c => c.p[0] === 'itinerary'));
  // A second restore, with the lock the vault writes after the first, is a no-op.
  const hashes = result.output.hashes;
  const restoredLock = { ...LOCK, section_hashes: hashes.sections, entries: Object.fromEntries(Object.entries(LOCK.entries).map(([k, e]) => [k, { ...e, hash: hashes.entries[k] }])) };
  const g = files(dir, { restored: restoredLock });
  // The snapshot holds a block added in the app (never in the lock): reported as drift, acknowledged.
  const captured = await syncPlan({ ...opts, last: g.restored }, TRIP);
  assert.deepEqual(captured.output.drift.map(r => [r.key, r.kind]), [['block:555000001', 'added']]);
  const h = files(dir, { ack2: { trip: TRIP, drift: captured.output.drift } });
  const again = await syncRestore({ ...opts, fromSnapshot: f.pre, last: g.restored, targetLock: g.restored, expectVersion: '102', ackDrift: h.ack2 }, TRIP);
  assert.equal(again.output.ops_applied, 0);
  assert.equal(server.posts.length, 1);
});

test('restore keeps the drift gate and the version gate', async t => {
  const server = fakeServer(t, docOf('edited'));
  const f = files(tmp(), { pre: docOf('base'), last: V.lock2, target: LOCK });
  const version = String(docOf('edited').tripPlan.overallVersion);
  const gated = await runSync({ ...opts, fromSnapshot: f.pre, last: f.last, targetLock: f.target, expectVersion: version }, 'restore', [TRIP]);
  assert.equal(gated.exitCode, EXIT.drift);
  const stale = await runSync({ ...opts, fromSnapshot: f.pre, last: f.last, targetLock: f.target, expectVersion: '1' }, 'restore', [TRIP]);
  assert.equal(stale.exitCode, EXIT.version);
  assert.equal(server.posts.length, 0);
});

// ---------- redaction and snapshots ----------

test('no access key survives redaction, wherever it sits', () => {
  const doc = clone(docOf('base'));
  doc.resources = { nested: { viewKey: 'VIEWSECRET01', list: [{ journalKey: 'JOURNALSECRET01' }] } };
  const text = JSON.stringify(redactTripDoc(doc));
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  const plan = redactTripDoc(doc).tripPlan;
  assert.equal(plan.editKey, '[REDACTED]');
  assert.deepEqual(plan.TripPlanKeys, [{ key: '[REDACTED]', type: 'view' }, { key: '[REDACTED]', type: 'edit' }]);
  assert.equal(plan.key, TRIP, 'the trip key itself is kept');
  assert.equal(doc.tripPlan.editKey, 'EDITSECRET01', 'input not mutated');
});

test('trips fetch --redacted --out writes a private file without access keys; plan --out-snapshot too', async t => {
  fakeServer(t, docOf('base'));
  const dir = tmp();
  const out = join(dir, 'snap.json');
  const result = await fetchRedacted({ ...opts, redacted: true, out }, TRIP);
  assert.equal(result.version, 100);
  assert.equal(statSync(out).mode & 0o777, 0o600);
  const text = readFileSync(out, 'utf8');
  for (const secret of SECRETS) assert.ok(!text.includes(secret), secret);
  await assert.rejects(() => fetchRedacted({ ...opts, out }, TRIP), /--redacted/);

  const snap = join(dir, 'pre.json');
  const report = join(dir, 'report.json');
  const f = files(dir, { lock: LOCK });
  await syncPlan({ ...opts, last: f.lock, outSnapshot: snap, outReport: report }, TRIP);
  const snapText = readFileSync(snap, 'utf8');
  for (const secret of SECRETS) assert.ok(!snapText.includes(secret), secret);
  assert.equal(JSON.parse(readFileSync(report, 'utf8')).snapshot, 'pre.json');
  // A redacted snapshot is a valid --snapshot input with identical results.
  const offline = await syncPlan({ snapshot: snap, last: f.lock }, TRIP);
  const online = await syncPlan({ ...opts, last: f.lock }, TRIP);
  assert.equal(stableJson(offline.output), stableJson(online.output));
});

// ---------- json0 subset ----------

test('applyJson0: text0 compares refuse with the server wording; od/oi, li, ld', () => {
  const root = { itinerary: { sections: [{ heading: 'Day', blocks: [1, 2] }] } };
  applyJson0(root, [{ p: ['itinerary', 'sections', 0, 'heading'], t: 'text0', o: [{ p: 0, d: 'Day' }, { p: 0, i: 'Day' }] }]);
  assert.throws(() => applyJson0(root, [{ p: ['itinerary', 'sections', 0, 'heading'], t: 'text0', o: [{ p: 0, d: 'Night' }, { p: 0, i: 'Night' }] }]), /does not match deleted text/);
  assert.throws(() => applyJson0(root, [{ p: ['itinerary', 'sections', 3, 'heading'], t: 'text0', o: [{ p: 0, d: 'x' }] }]), /Cannot read properties of undefined/);
  applyJson0(root, [{ p: ['itinerary', 'sections', 0, 'blocks'], od: [1, 2], oi: [3] }, { p: ['itinerary', 'sections', 1], li: { heading: 'New' } }]);
  assert.deepEqual(root.itinerary.sections, [{ heading: 'Day', blocks: [3] }, { heading: 'New' }]);
  applyJson0(root, [{ p: ['itinerary', 'sections', 0], ld: root.itinerary.sections[0] }]);
  assert.deepEqual(root.itinerary.sections, [{ heading: 'New' }]);
  assert.throws(() => applyJson0(root, [{ p: ['itinerary', 'sections', 5], li: {} }]), /out of bounds/);
});

test('normOps is Delta normal form', () => {
  assert.deepEqual(normOps([{ insert: 'a' }, { insert: '' }, { insert: 'b', attributes: {} }, { insert: 'c', attributes: { bold: true } }, { insert: 'd', attributes: { bold: true } }]),
    [{ insert: 'ab' }, { insert: 'cd', attributes: { bold: true } }]);
});

// ---------- other primitives ----------

test('trips validate --check-dates: day count and anchored dates', () => {
  const plan = clone(docOf('after'));
  assert.equal(validateTripPlanStructure(plan, { checkDates: true }).valid, true);
  const short = clone(plan);
  short.tripPlan.endDate = '2027-05-13';
  const result = validateTripPlanStructure(short, { checkDates: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /2 dayPlan sections for 3 trip days/);
  const shifted = clone(plan);
  shifted.tripPlan.itinerary.sections[6].date = '2027-05-14';
  assert.match(validateTripPlanStructure(shifted, { checkDates: true }).errors.join('\n'), /day 2 is dated 2027-05-14, expected 2027-05-12/);
  const undated = clone(plan);
  undated.tripPlan.startDate = null;
  assert.match(validateTripPlanStructure(undated, { checkDates: true }).errors.join('\n'), /no startDate/);
  assert.equal(validateTripPlanStructure(short).valid, true, 'unchanged without --check-dates');
});

test('sync flags parse; sync help lists the exit codes; trips help says delete moves to Trash', async () => {
  const parsed = parseArgs(['sync', 'apply', TRIP, '--desired', 'd.json', '--last', 'l.json', '--expect-version', '7', '--ack-drift', 'r.json', '--out-snapshot', 'p.json', '--json']);
  assert.deepEqual([parsed.command, parsed.subcommand, parsed.args[0]], ['sync', 'apply', TRIP]);
  assert.equal(parsed.options.expectVersion, '7');
  assert.equal(parsed.options.ackDrift, 'r.json');
  assert.equal(parsed.options.outSnapshot, 'p.json');
  const restore = parseArgs(['sync', 'restore', TRIP, '--from-snapshot', 's', '--target-lock', 't', '--out-report', 'r']).options;
  assert.deepEqual([restore.fromSnapshot, restore.targetLock, restore.outReport], ['s', 't', 'r']);
  assert.equal(parseArgs(['places', 'resolve', '--place-id', 'abc']).options.placeId, 'abc');
  assert.equal(parseArgs(['trips', 'fetch', TRIP, '--redacted', '--out', 'f']).options.redacted, true);
  assert.equal(parseArgs(['trips', 'validate', TRIP, '--check-dates']).options.checkDates, true);
  const sync = await createCommandDispatcher({ help: true }).execute('sync', null, []);
  assert.match(sync.data, /10 unacknowledged drift/);
  const trips = await createCommandDispatcher({ help: true }).execute('trips', null, []);
  assert.match(trips.data, /Moves the trip to Wanderlog's Trash/);
});

test('sync plan --snapshot runs offline through the dispatcher and returns raw JSON with its exit code', async () => {
  const f = files(tmp(), { snap: docOf('after'), desired: V.desired2, lock: V.lock2 });
  const result = await createCommandDispatcher({ snapshot: f.snap, desired: f.desired, last: f.lock, format: 'json' }).execute('sync', 'plan', [TRIP]);
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.rawOutput).op_count, 0);
});

test('trips delete reports that the trip went to Trash', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ success: true });
  t.after(() => { globalThis.fetch = original; });
  const result = await deleteTrip(opts, TRIP, { confirm: TRIP });
  assert.equal(result.trashed, true);
  assert.match(result.note, /Trash/);
});

test('places resolve returns plan.yaml place fields without touching Wanderlog', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).includes(':searchText')) return json({ places: [{ id: 'gid-1' }] });
    return json({ id: 'gid-1', displayName: { text: 'Harbour Inn' }, formattedAddress: 'Rua 60', location: { latitude: 38.7, longitude: -9.1 }, types: ['lodging'] });
  };
  const byQuery = await resolvePlace({ query: 'harbour inn', googleKey: 'k', fetchImpl });
  assert.deepEqual(byQuery, { query: 'harbour inn', place_id: 'gid-1', name: 'Harbour Inn', formatted_address: 'Rua 60', lat: 38.7, lng: -9.1, types: ['lodging'], plan_place: { google_id: 'gid-1', address: 'Rua 60', lat: 38.7, lng: -9.1 } });
  const byId = await resolvePlace({ placeId: 'gid-1', googleKey: 'k', fetchImpl });
  assert.equal(byId.place_id, 'gid-1');
  assert.ok(calls.every(u => u.startsWith('https://places.googleapis.com/')));
  await assert.rejects(() => resolvePlace({ googleKey: 'k', fetchImpl }), /--query/);
  await assert.rejects(() => resolvePlace({ query: 'a', placeId: 'b', googleKey: 'k', fetchImpl }), /--query/);
});

test('trips create sends the web app body and fails loudly on a server error', async t => {
  const { createTrip } = await import('../src/trips.mjs');
  const bodies = [];
  let reply = { success: true, data: { key: 'newtripkey000001', viewKey: 'VIEWSECRET01', id: 5, title: 'Trip to Lisbon', createdSectionIds: [] } };
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes('/api/geo/autocomplete/')) return json([{ id: 9626, name: 'Lisbon' }]);
    bodies.push(JSON.parse(init.body));
    return json(reply);
  };
  t.after(() => { globalThis.fetch = original; });
  const created = await createTrip(opts, { destination: 'Lisbon', startDate: '2027-03-01', endDate: '2027-03-03' });
  assert.deepEqual(created, { id: 5, key: 'newtripkey000001', title: 'Trip to Lisbon', startDate: '2027-03-01', endDate: '2027-03-03', destination: null, updatedAt: null });
  assert.equal(bodies[0].type, 'plan');
  assert.deepEqual(bodies[0].initialMapsPlaceIds, []);
  assert.deepEqual(bodies[0].geoIds, [9626]);
  reply = { success: false, errTypes: ['unexpectedError'], error: "TypeError: Cannot read properties of undefined (reading 'length')" };
  await assert.rejects(() => createTrip(opts, { destination: 'Lisbon' }), /did not create the trip \(unexpectedError\)/);
});
