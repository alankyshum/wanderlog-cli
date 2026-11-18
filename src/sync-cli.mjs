// I/O side of `wlog sync plan|apply|restore` and `wlog trips fetch --redacted`: reading the
// input files, fetching, the version and drift gates, posting one guarded batch, verifying and
// writing private (0600) output files. The pure logic is in sync.mjs.

import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { basename } from 'node:path';
import { createClient } from './client.mjs';
import { applyGuardedOps } from './trips.mjs';
import {
  AuthExpiredError, AuthRequiredError, ConcurrentChangeError, NotFoundError, TokenCorruptError, UsageError, VerificationError,
} from './errors.mjs';
import {
  EXIT, NATIVE_SECTIONS, SyncExit, TRAVEL_MODES, analyse, assertBatchSchema, blockTypesFor, buildApplyBatch, buildRestoreBatch,
  redactTripDoc, same, simulate, stableJson, structureErrors, tripPlanOf,
} from './sync.mjs';

// ---------- files ----------

export function writePrivate(path, text) {
  const partial = `${path}.${process.pid}.partial`;
  const fd = openSync(partial, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(partial, 0o600);
  renameSync(partial, path);
}

function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new SyncExit(EXIT.usage, `${what}: cannot read ${path} (${err.code ?? err.message})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SyncExit(EXIT.usage, `${what}: ${path} is not JSON`);
  }
}

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const placeOk = p => Boolean(p?.name) && Number.isFinite(Number(p?.geometry?.location?.lat)) && Number.isFinite(Number(p?.geometry?.location?.lng));

// What a desired flight, train or rental car lacks for the CLI to build a native block (null: ok).
// The airline may be given by its IATA code alone; the CLI completes it from Wanderlog's list.
function reservationProblem(b) {
  const sides = { flight: ['depart', 'arrive'], train: ['depart', 'arrive'], rentalCar: ['pickUp', 'dropOff'] }[b.type];
  if (!sides) return null;
  for (const side of sides) {
    const end = b[side];
    if (!isObject(end) || !DATE.test(end.date ?? '')) return `needs ${side}.date (YYYY-MM-DD)`;
    if (end.time != null && !CLOCK.test(end.time)) return `${side}.time must be HH:MM or absent`;
    if (b.type === 'flight') {
      if (!/^[A-Z0-9]{3}$/.test(end.airport?.iata ?? '') || !end.airport?.name || typeof (end.airport?.cityName ?? '') !== 'string') return `needs ${side}.airport {iata, name, cityName}`;
      if (!placeOk(end.airport.googlePlace)) return `needs ${side}.airport.googlePlace with name and geometry.location`;
    } else if (!placeOk(end.place)) {
      return `needs ${side}.place with name and geometry.location`;
    }
    if (b.type === 'rentalCar' && !(isObject(end.airportOrGeo) && typeof end.airportOrGeo.type === 'string' && isObject(end.airportOrGeo.value))) {
      return `needs ${side}.airportOrGeo (Wanderlog's {type, value}, carried verbatim)`;
    }
  }
  if (b.type === 'flight') {
    if (!/^[A-Z0-9]{2}$/.test(b.flightInfo?.airline?.iata ?? '')) return 'needs flightInfo.airline.iata (two characters)';
    if (!Number.isInteger(b.flightInfo?.number)) return 'needs an integer flightInfo.number';
  }
  return null;
}

const AIRLINE_FIELDS = ['iata', 'icao', 'name', 'localizedName'];

// Fills each flight's airline {iata, icao, name, localizedName} from Wanderlog's own airline list
// (GET /api/flights/allAirlines, read-only) when the desired document gives only part of it.
// Exactly one airline must carry the code; an unexpected response shape fails closed (exit 4).
export async function completeAirlines(opts, desired) {
  const flights = desired.sections.flatMap(s => s.blocks).filter(b => b.type === 'flight');
  const partial = flights.filter(b => !AIRLINE_FIELDS.every(k => typeof b.flightInfo.airline[k] === 'string' && b.flightInfo.airline[k]));
  if (!partial.length) return desired;
  let data;
  try {
    data = await createClient(opts).get('/api/flights/allAirlines');
  } catch (err) {
    throw new SyncExit(EXIT.fetch, `Airline list fetch failed (${err?.name ?? 'Error'}: ${err?.message ?? err})`);
  }
  const airlines = airlineList(data);
  for (const b of partial) {
    const given = b.flightInfo.airline;
    const hits = airlines.filter(a => a.iata === given.iata);
    if (hits.length !== 1) throw new SyncExit(EXIT.usage, `--desired: flight ${b.key} airline ${given.iata} matches ${hits.length} Wanderlog airlines; give icao, name and localizedName`);
    for (const k of AIRLINE_FIELDS) if (given[k] != null && given[k] !== hits[0][k]) {
      throw new SyncExit(EXIT.usage, `--desired: flight ${b.key} airline ${k} ${JSON.stringify(given[k])} differs from Wanderlog's ${JSON.stringify(hits[0][k])}`);
    }
    b.flightInfo.airline = { ...hits[0] };
  }
  return desired;
}

export function airlineList(data) {
  if (!isObject(data) || data.success !== true || !Array.isArray(data.data)) throw new SyncExit(EXIT.fetch, 'Airline list: unexpected response shape (expected {success: true, data: [...]})');
  return data.data.map((a, i) => {
    if (!isObject(a) || !AIRLINE_FIELDS.every(k => a[k] === null || typeof a[k] === 'string')) throw new SyncExit(EXIT.fetch, `Airline list: row ${i} has an unexpected shape`);
    return Object.fromEntries(AIRLINE_FIELDS.map(k => [k, a[k]]));
  });
}

export function loadDesired(path) {
  const desired = readJson(path, '--desired');
  if (!isObject(desired) || desired.desired_version !== 1 || !Array.isArray(desired.sections)) {
    throw new SyncExit(EXIT.usage, '--desired: expected desired_version 1 with a sections array');
  }
  const keys = new Set();
  const nativeTypes = new Map();
  for (const s of desired.sections) {
    if (!isObject(s) || typeof s.key !== 'string' || !Array.isArray(s.blocks) || typeof s.type !== 'string' || typeof s.mode !== 'string') {
      throw new SyncExit(EXIT.usage, '--desired: every section needs key, type, mode and blocks');
    }
    if (keys.has(s.key)) throw new SyncExit(EXIT.usage, `--desired: section ${s.key} appears twice`);
    keys.add(s.key);
    if (s.id != null && !Number.isInteger(s.id)) throw new SyncExit(EXIT.usage, `--desired: section ${s.key} id must be an integer or null`);
    if (NATIVE_SECTIONS[s.type]) {
      if (s.mode !== 'placeList') throw new SyncExit(EXIT.usage, `--desired: section ${s.key} (${s.type}) must use mode placeList`);
      if (nativeTypes.has(s.type)) throw new SyncExit(EXIT.usage, `--desired: two ${s.type} sections (${nativeTypes.get(s.type)}, ${s.key}); a trip has one`);
      nativeTypes.set(s.type, s.key);
    }
    const allowed = blockTypesFor(s.type);
    for (const b of s.blocks) {
      if (!isObject(b) || typeof b.key !== 'string' || !Number.isInteger(b.id) || !allowed.includes(b.type)) {
        throw new SyncExit(EXIT.usage, `--desired: section ${s.key} has a block without key, integer id or a ${allowed.join('/')} type`);
      }
      if (b.type === 'place' && !placeOk(b.place)) {
        throw new SyncExit(EXIT.usage, `--desired: place ${b.key} needs place.name and place.geometry.location`);
      }
      if (b.type === 'place' && b.travelMode != null && !TRAVEL_MODES.includes(b.travelMode)) {
        throw new SyncExit(EXIT.usage, `--desired: place ${b.key} travelMode must be null or one of ${TRAVEL_MODES.join(', ')}`);
      }
      const problem = reservationProblem(b);
      if (problem) throw new SyncExit(EXIT.usage, `--desired: ${b.type} ${b.key} ${problem}`);
      if (b.type === 'checklist' && (!Array.isArray(b.items) || b.items.some(r => !Number.isInteger(r?.id)))) {
        throw new SyncExit(EXIT.usage, `--desired: checklist ${b.key} needs items with integer ids`);
      }
    }
  }
  return desired;
}

export function loadLock(path, flag) {
  const lock = readJson(path, flag);
  if (!isObject(lock) || lock.lock_version !== 1 || !isObject(lock.sections) || !isObject(lock.entries)) {
    throw new SyncExit(EXIT.usage, `${flag}: expected a lock.json with lock_version 1, sections and entries`);
  }
  return lock;
}

function loadSnapshot(path, flag) {
  const doc = readJson(path, flag);
  try {
    tripPlanOf(doc);
  } catch {
    throw new SyncExit(EXIT.usage, `${flag}: not a trip fetch (no tripPlan.itinerary.sections)`);
  }
  return doc;
}

function loadAck(path, tripKey) {
  const report = readJson(path, '--ack-drift');
  if (!isObject(report) || !Array.isArray(report.drift)) throw new SyncExit(EXIT.usage, '--ack-drift: expected a drift report with a drift array');
  if (report.trip != null && report.trip !== tripKey) throw new SyncExit(EXIT.usage, `--ack-drift: report is for trip ${report.trip}`);
  return report;
}

function expectVersion(value) {
  const n = Number(value);
  if (value == null || !Number.isInteger(n)) throw new SyncExit(EXIT.usage, '--expect-version <overallVersion> is required (an integer from sync plan)');
  return n;
}

function required(value, flag) {
  if (!value) throw new SyncExit(EXIT.usage, `${flag} is required`);
  return value;
}

// ---------- Wanderlog ----------

export async function fetchTripDoc(opts, tripKey) {
  let data;
  try {
    data = await createClient(opts).get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
  } catch (err) {
    throw new SyncExit(EXIT.fetch, `Fetch failed for the trip (${err?.name ?? 'Error'}: ${err?.message ?? err}); run wlog auth recover, then re-run once`);
  }
  if (!data?.tripPlan) {
    throw new SyncExit(EXIT.fetch, `Fetch returned no trip (${[].concat(data?.errTypes ?? 'no error type').join(', ')})`);
  }
  return data;
}

function keyRefusal(doc, tripKey) {
  const key = tripPlanOf(doc).key;
  return key != null && key !== tripKey ? [`trip key ${key} in the document differs from ${tripKey}`] : [];
}

function gateDrift(drift, ack) {
  const acked = new Set((ack?.drift || []).map(r => r.fingerprint));
  const unacknowledged = drift.filter(r => !acked.has(r.fingerprint));
  if (unacknowledged.length) {
    throw new SyncExit(EXIT.drift, `${unacknowledged.length} drift record(s) are not in --ack-drift; nothing written. Re-run sync plan and show the report`, { unacknowledged });
  }
}

function landed(desired) {
  const out = structuredClone(desired);
  for (const s of out.sections) {
    s.new = false;
    for (const b of s.blocks) {
      b.new = false;
      for (const row of b.items || []) row.new = false;
    }
  }
  return out;
}

// The lock as the vault writes it after a verified push: only keys the desired document still has.
// Verification uses it, so sections and blocks the push removed on purpose are not "missing".
function postLock(lock, desired) {
  if (!lock) return lock;
  const sections = new Set(desired.sections.map(s => s.key));
  const entries = new Set(desired.sections.flatMap(s => s.blocks.map(b => b.key)));
  return {
    ...lock,
    sections: Object.fromEntries(Object.entries(lock.sections).filter(([k]) => sections.has(k))),
    entries: Object.fromEntries(Object.entries(lock.entries).filter(([k]) => entries.has(k))),
  };
}

async function post(opts, tripKey, components, label) {
  try {
    return await applyGuardedOps(opts, tripKey, components, {
      label,
      subject: 'Sync',
      changed: 'The trip changed since the fetch',
      inspect: `wlog sync plan ${tripKey} --json`,
    });
  } catch (err) {
    if (err instanceof VerificationError) throw new SyncExit(EXIT.uncertain, err.message);
    if (err instanceof ConcurrentChangeError) throw new SyncExit(EXIT.guard, err.message);
    if (err instanceof AuthRequiredError || err instanceof AuthExpiredError || err instanceof TokenCorruptError || err instanceof NotFoundError) {
      throw new SyncExit(EXIT.fetch, `${err.message}; nothing was written`);
    }
    throw new SyncExit(EXIT.guard, `${err?.message ?? err}`);
  }
}

// ---------- commands ----------

export async function syncPlan(opts, tripKey) {
  if (!tripKey) throw new SyncExit(EXIT.usage, 'Usage: wlog sync plan <tripKey> [--desired F] [--last F] [--snapshot F] [--out-snapshot F] [--out-report F] --json');
  const desired = opts.desired ? await completeAirlines(opts, loadDesired(opts.desired)) : null;
  const lock = opts.last ? loadLock(opts.last, '--last') : null;
  let doc;
  if (opts.snapshot) {
    doc = loadSnapshot(opts.snapshot, '--snapshot');
  } else {
    doc = await fetchTripDoc(opts, tripKey);
    if (opts.outSnapshot) writePrivate(opts.outSnapshot, stableJson(redactTripDoc(doc)));
  }
  const found = analyse(doc, desired, lock);
  found.refusals = [...new Set([...found.refusals, ...keyRefusal(doc, tripKey)])].sort();
  if (lock && opts.outReport) {
    const snapshot = !opts.snapshot && opts.outSnapshot ? basename(opts.outSnapshot) : null;
    writePrivate(opts.outReport, stableJson({ trip: tripKey, version: found.version, snapshot, drift: found.drift }));
  }
  const output = {
    version: found.version, op_count: found.op_count, ops: found.ops, drift: found.drift, refusals: found.refusals,
    hashes: found.hashes, matched: found.matched, resolved: found.resolved,
  };
  return { exitCode: found.refusals.length ? EXIT.refused : EXIT.ok, output };
}

export async function syncApply(opts, tripKey) {
  if (!tripKey) throw new SyncExit(EXIT.usage, 'Usage: wlog sync apply <tripKey> --desired F --last F --expect-version N [--ack-drift F] [--out-snapshot F] --json');
  const desired = await completeAirlines(opts, loadDesired(required(opts.desired, '--desired')));
  const lock = opts.last ? loadLock(opts.last, '--last') : null;
  const expected = expectVersion(opts.expectVersion);
  const ack = opts.ackDrift ? loadAck(opts.ackDrift, tripKey) : null;

  const doc = await fetchTripDoc(opts, tripKey);
  const before = tripPlanOf(doc).overallVersion;
  if (before !== expected) throw new SyncExit(EXIT.version, `overallVersion is ${before}, expected ${expected}: the trip changed since sync plan; nothing written`, { expected, found: before });
  const found = analyse(doc, desired, lock);
  const refusals = [...new Set([...found.refusals, ...keyRefusal(doc, tripKey)])].sort();
  if (refusals.length) throw new SyncExit(EXIT.refused, `Refused: ${refusals.join('; ')}`, { refusals });
  gateDrift(found.drift, ack);

  const target = landed(found.desired);
  const afterLock = postLock(lock, target);
  let after = doc;
  let components = [];
  if (found.op_count > 0) {
    const batch = buildApplyBatch(doc, found.desired, lock);
    components = batch.components;
    assertBatchSchema(components, batch.knownBlocks);
    const simulated = simulate(doc, components);
    const errors = structureErrors(simulated);
    if (errors.length) throw new SyncExit(EXIT.refused, `Refusing a batch that would leave the trip invalid: ${errors.join('; ')}`, { refusals: errors });
    const check = analyse(simulated, target, afterLock);
    if (check.op_count || check.refusals.length) {
      throw new SyncExit(EXIT.refused, 'Refusing a batch that does not reach the desired state when simulated (CLI bug); nothing written', { refusals: check.refusals, ops: check.ops });
    }
    after = await post(opts, tripKey, components, `sync of ${found.op_count} section op(s)`);
  }
  return finishVerify(opts, after, {
    before, posted: components.length > 0,
    check: () => {
      const verify = analyse(after, target, afterLock);
      return { ok: verify.op_count === 0 && verify.refusals.length === 0, verify, detail: { ops: verify.ops, refusals: verify.refusals } };
    },
    output: verify => ({ ops_applied: found.op_count, components: components.length, hashes: verify.hashes, matched: found.matched, resolved: found.resolved }),
  });
}

export async function syncRestore(opts, tripKey) {
  if (!tripKey) throw new SyncExit(EXIT.usage, 'Usage: wlog sync restore <tripKey> --from-snapshot S --last L --target-lock T --expect-version N [--ack-drift F] [--out-snapshot F] --json');
  const snapshot = loadSnapshot(required(opts.fromSnapshot, '--from-snapshot'), '--from-snapshot');
  const last = loadLock(required(opts.last, '--last'), '--last');
  const targetLock = loadLock(required(opts.targetLock, '--target-lock'), '--target-lock');
  const expected = expectVersion(opts.expectVersion);
  const ack = opts.ackDrift ? loadAck(opts.ackDrift, tripKey) : null;

  const doc = await fetchTripDoc(opts, tripKey);
  const before = tripPlanOf(doc).overallVersion;
  if (before !== expected) throw new SyncExit(EXIT.version, `overallVersion is ${before}, expected ${expected}: the trip changed since sync plan; nothing written`, { expected, found: before });
  const found = analyse(doc, null, last);
  const refusals = [...new Set([...found.refusals, ...keyRefusal(doc, tripKey), ...keyRefusal(snapshot, tripKey)])].sort();
  if (refusals.length) throw new SyncExit(EXIT.refused, `Refused: ${refusals.join('; ')}`, { refusals });
  gateDrift(found.drift, ack);

  const want = analyse(snapshot, null, targetLock).hashes;
  const batch = buildRestoreBatch(doc, snapshot, last, targetLock);
  let after = doc;
  if (batch.components.length) {
    assertBatchSchema(batch.components, batch.knownBlocks);
    const simulated = simulate(doc, batch.components);
    const errors = structureErrors(simulated);
    if (errors.length) throw new SyncExit(EXIT.refused, `Refusing a restore that would leave the trip invalid: ${errors.join('; ')}`, { refusals: errors });
    if (!same(analyse(simulated, null, targetLock).hashes, want)) {
      throw new SyncExit(EXIT.refused, 'Refusing a restore that does not reproduce the snapshot when simulated (CLI bug); nothing written');
    }
    after = await post(opts, tripKey, batch.components, `restore of ${batch.changedSections} section(s)`);
  }
  return finishVerify(opts, after, {
    before, posted: batch.components.length > 0,
    check: () => {
      const verify = analyse(after, null, targetLock);
      return { ok: same(verify.hashes, want), verify, detail: { refusals: verify.refusals } };
    },
    output: verify => ({ ops_applied: batch.changedSections, components: batch.components.length, hashes: verify.hashes, matched: {} }),
  });
}

// Post-write verification shared by apply and restore: re-fetched state equals the target and
// overallVersion rose by exactly 1 (0 when nothing was posted). A mismatch is exit 7, never retried.
function finishVerify(opts, after, { before, posted, check, output }) {
  if (opts.outSnapshot) writePrivate(opts.outSnapshot, stableJson(redactTripDoc(after)));
  const versionAfter = tripPlanOf(after).overallVersion;
  const { ok, verify, detail } = check();
  const versionOk = versionAfter === before + (posted ? 1 : 0);
  if (!ok || !versionOk) {
    throw new SyncExit(EXIT.uncertain, `Write sent but the re-fetched trip does not match (${!ok ? 'content differs' : `overallVersion ${before} -> ${versionAfter}`}); not retried. Inspect with wlog sync plan before anything else`, {
      version_before: before, version_after: versionAfter, ...detail,
    });
  }
  return { exitCode: EXIT.ok, output: { version_before: before, version_after: versionAfter, verified: true, ...output(verify) } };
}

// `wlog trips fetch <tripKey> --redacted --out F`: a redacted snapshot in a private file.
export async function fetchRedacted(opts, tripKey) {
  if (!tripKey || !opts.out) throw new UsageError('Usage: wlog trips fetch <tripKey> --redacted --out <file>');
  if (!opts.redacted) throw new UsageError('trips fetch writes redacted snapshots only: pass --redacted (use debug fetch to see a raw response)');
  let doc;
  try {
    doc = await fetchTripDoc(opts, tripKey);
  } catch (err) {
    if (err instanceof SyncExit) throw new NotFoundError(err.message);
    throw err;
  }
  writePrivate(opts.out, stableJson(redactTripDoc(doc)));
  const plan = tripPlanOf(doc);
  return { tripKey, out: opts.out, version: plan.overallVersion, sections: plan.itinerary.sections.length, redacted: true };
}

export function failure(exitCode, message, payload = {}) {
  return { exitCode, rawOutput: stableJson({ ...payload, error: { type: 'SyncExit', message }, exit: exitCode }), stderr: `SyncExit: ${message}` };
}

// Runs one sync subcommand; every outcome, including failures, is one JSON document on stdout
// and an exit code from the contract's table.
export async function runSync(opts, subcommand, args) {
  const commands = { plan: syncPlan, apply: syncApply, restore: syncRestore };
  try {
    const command = commands[subcommand];
    if (!command) throw new SyncExit(EXIT.usage, 'Usage: wlog sync <plan|apply|restore> <tripKey> ... --json');
    const { exitCode, output } = await command(opts, args[0]);
    return { exitCode, rawOutput: stableJson(output) };
  } catch (err) {
    if (!(err instanceof SyncExit)) {
      const code = err instanceof UsageError ? EXIT.usage : 1;
      return { exitCode: code, rawOutput: stableJson({ error: { type: err?.name ?? 'Error', message: String(err?.message ?? err) }, exit: code }), stderr: `${err?.name ?? 'Error'}: ${err?.message ?? err}` };
    }
    return failure(err.exitCode, err.message, err.payload);
  }
}
