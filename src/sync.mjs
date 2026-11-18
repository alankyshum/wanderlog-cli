// `wlog sync plan|apply|restore`: make a trip's managed sections match a desired document.
//
// The vault derives `desired.json` (trip meaning, local keys, Quill ops, no Wanderlog bookkeeping);
// this module fetches, normalises, diffs, guards, posts one batch and verifies (Wanderlog mechanics).
// Contract: the vault's trip-plan/reference/sync-cli-contract.md; its executable reference is the
// vault's fake_sync_wlog.py, and test/fixtures/sync/vectors.json holds that reference's outputs.
//
// Write shape (measured on a throwaway trip, branch trip-sync/spike): one applyOps batch per run.
// It starts with text0 compares on the pre-state (heading, day date, one identity string per
// current block: place name, first text op, checklist title, a flight's airport/airline/date,
// a train's or car's first place name and date), then replaces whole `blocks`
// arrays with od/oi (ids kept, unmodelled fields carried), sets headings and Notes text, deletes
// and inserts list sections. Wanderlog raises `overallVersion` by exactly 1 per batch.
//
// The CLI owns the native field set of every block it writes (a place block with only
// id/type/place/text broke a real trip): see nativeBlock() and checkBlockSchema().

import { createHash } from 'node:crypto';
import { validateTripPlanStructure } from './validation.mjs';

export const SECRET_FIELDS = ['editKey', 'viewKey', 'suggestKey', 'journalKey'];
export const REDACTED = '[REDACTED]';
const PLACE_FIELDS = ['name', 'formatted_address', 'place_id'];
const MAX_MISSING = 3;
const PLAN_BLOCKS = ['place', 'note', 'checklist'];
// Native reservation sections hold one block type each (spike S7 on a throwaway trip).
const RESERVATION_BLOCKS = { flights: ['flight'], transit: ['train'], rentalCars: ['rentalCar'] };
export const BLOCK_TYPES = [...PLAN_BLOCKS, 'flight', 'train', 'rentalCar'];
export const blockTypesFor = sectionType => RESERVATION_BLOCKS[sectionType] ?? PLAN_BLOCKS;
const RESERVATION_TYPES = new Set(Object.values(RESERVATION_BLOCKS).flat());
// A place card's travelMode is the mode of the leg that arrives at it (null: Wanderlog's default).
export const TRAVEL_MODES = ['driving', 'walking', 'transit'];
// The web app's native list sections, one per trip, in the order it shows them after Notes (rank).
// Hotels: the December trip and `lodging add`; the others: spike S7 (UI-created sections).
export const NATIVE_SECTIONS = {
  flights: { rank: 1, placeMarkerColor: '#3498db', placeMarkerIcon: 'plane' },
  hotels: { rank: 2, placeMarkerColor: '#e67e22', placeMarkerIcon: 'bed' },
  rentalCars: { rank: 3, placeMarkerColor: '#38a4a6', placeMarkerIcon: 'car' },
  transit: { rank: 4, placeMarkerColor: '#17b978', placeMarkerIcon: 'subway' },
};
const SECTION_SHAPES = new Set(['normal/dayPlan', 'normal/placeList', 'textOnly/placeList', ...Object.keys(NATIVE_SECTIONS).map(t => `${t}/placeList`)]);
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Exit codes of the sync commands (the vault contract's table).
export const EXIT = { ok: 0, usage: 2, refused: 3, fetch: 4, guard: 5, uncertain: 7, version: 8, drift: 10 };

export class SyncExit extends Error {
  constructor(exitCode, message, payload = {}) {
    super(message);
    this.name = 'SyncExit';
    this.exitCode = exitCode;
    this.payload = payload;
  }
}

// ---------- canonical JSON and hashes ----------

// Sorted keys, no whitespace, UTF-8 as written; undefined counts as null. Same text as the
// reference's json.dumps(sort_keys=True, ensure_ascii=False, separators=(',', ':')).
export function canon(value) {
  if (value === undefined || value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha(value) {
  return createHash('sha256').update(canon(value), 'utf8').digest('hex');
}

// Pretty, sorted-key JSON for stdout and files: the same input always gives the same bytes.
export function stableJson(value) {
  const sortDeep = v => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => [k, sortDeep(v[k])]));
    }
    return v;
  };
  return `${JSON.stringify(sortDeep(value), null, 2)}\n`;
}

const clone = value => (value === undefined ? undefined : structuredClone(value));
export const same = (a, b) => canon(a) === canon(b);
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const pyStr = value => (value === null || value === undefined ? 'None' : String(value));
function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value !== 'string') return String(value);
  if (value.includes("'") && !value.includes('"')) return `"${value}"`;
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

// ---------- normal form (contract "Normal form") ----------

// Delta normal form: drop empty inserts, merge neighbours with equal attributes.
export function normOps(ops) {
  const out = [];
  for (const op of ops) {
    if (op.insert === '') continue;
    const next = { insert: op.insert };
    if (op.attributes && Object.keys(op.attributes).length) next.attributes = op.attributes;
    const last = out.at(-1);
    if (last && typeof last.insert === 'string' && typeof next.insert === 'string' && same(last.attributes, next.attributes)) {
      last.insert += next.insert;
    } else {
      out.push(clone(next));
    }
  }
  return out;
}

export function textOf(text) {
  const found = text && typeof text === 'object' && Array.isArray(text.ops) ? text.ops : null;
  return { ops: found && found.length ? normOps(clone(found)) : [{ insert: '\n' }] };
}

const num = value => Number(value);

// A Google place in normal form: name, address, location and (when known) the Google id.
export function normPlace(place) {
  const p = place && typeof place === 'object' ? place : {};
  const location = p.geometry?.location || {};
  const out = {
    name: p.name || '',
    formatted_address: p.formatted_address || '',
    geometry: { location: { lat: num(location.lat ?? 0), lng: num(location.lng ?? 0) } },
  };
  if (p.place_id) out.place_id = p.place_id;
  return out;
}

// A reservation endpoint's date and time: null or empty is absent.
function when(raw, out) {
  for (const name of ['date', 'time']) if (raw?.[name]) out[name] = raw[name];
  return out;
}

function normAirline(airline) {
  const a = airline && typeof airline === 'object' ? airline : {};
  return { iata: a.iata ?? null, icao: a.icao ?? null, name: a.name ?? null, localizedName: a.localizedName ?? null };
}

export function normBlock(raw) {
  const kind = raw.type;
  const out = { id: Number(raw.id), type: kind };
  if (kind === 'place') {
    out.place = normPlace(raw.place);
    out.text = textOf(raw.text);
    for (const name of ['startTime', 'endTime']) if (raw[name]) out[name] = raw[name];
    if (raw.travelMode != null) out.travelMode = raw.travelMode;
    if (raw.hotel && typeof raw.hotel === 'object' && !Array.isArray(raw.hotel)) {
      out.hotel = { checkIn: raw.hotel.checkIn ?? null, checkOut: raw.hotel.checkOut ?? null, confirmationNumber: raw.hotel.confirmationNumber || '' };
    }
  } else if (kind === 'flight') {
    out.text = textOf(raw.text);
    out.confirmationNumber = raw.confirmationNumber || '';
    out.flightInfo = { airline: normAirline(raw.flightInfo?.airline), number: raw.flightInfo?.number ?? null };
    for (const side of ['depart', 'arrive']) {
      const airport = raw[side]?.airport || {};
      out[side] = when(raw[side], { airport: { iata: airport.iata ?? null, name: airport.name || '', cityName: airport.cityName || '', googlePlace: normPlace(airport.googlePlace) } });
    }
  } else if (kind === 'train') {
    out.text = textOf(raw.text);
    out.confirmationNumber = raw.confirmationNumber || '';
    out.carrier = raw.carrier || '';
    for (const side of ['depart', 'arrive']) out[side] = when(raw[side], { place: normPlace(raw[side]?.place) });
  } else if (kind === 'rentalCar') {
    out.text = textOf(raw.text);
    if (raw.confirmationNumber) out.confirmationNumber = raw.confirmationNumber;
    for (const side of ['pickUp', 'dropOff']) {
      out[side] = when(raw[side], { airportOrGeo: clone(raw[side]?.airportOrGeo ?? null), place: normPlace(raw[side]?.place) });
    }
  } else if (kind === 'note') {
    out.text = textOf(raw.text);
  } else if (kind === 'checklist') {
    out.title = raw.title || '';
    out.items = (raw.items || []).map(row => ({ id: Number(row.id), text: textOf(row.text), checked: Boolean(row.checked) }));
  }
  return out;
}

// A desired block in normal form: no local key or new flag, numbers and text normalised.
export function strip(block) {
  const out = {};
  for (const [k, v] of Object.entries(block)) if (k !== 'key' && k !== 'new') out[k] = clone(v);
  // Reservation blocks: the desired document is the normal form, normalised the same way.
  if (RESERVATION_TYPES.has(out.type)) return normBlock(out);
  if (out.type === 'place' && out.travelMode == null) delete out.travelMode;
  if (out.items) out.items = out.items.map(row => Object.fromEntries(Object.entries(row).filter(([k]) => k !== 'key' && k !== 'new').map(([k, v]) => [k, k === 'text' ? textOf(v) : v])));
  if (out.place) {
    const location = out.place.geometry.location;
    out.place.geometry.location = { lat: num(location.lat), lng: num(location.lng) };
  }
  if (out.text) out.text = textOf(out.text);
  return out;
}

export function sectionSummary(id, section, blockIds) {
  const out = { id, type: section.type, mode: section.mode, heading: section.heading || '', blocks: blockIds };
  if (section.mode === 'dayPlan') out.date = section.date ?? null;
  if (section.type === 'textOnly') out.text = textOf(section.text);
  return out;
}

function noIds(block) {
  const out = { ...block };
  delete out.id;
  if (out.items) out.items = out.items.map(({ id, ...rest }) => rest);
  return out;
}

export function tripPlanOf(doc) {
  const plan = doc?.tripPlan ?? doc?.data?.tripPlan;
  if (!plan || !Array.isArray(plan.itinerary?.sections)) throw new SyncExit(EXIT.fetch, 'Trip document has no tripPlan.itinerary.sections');
  return plan;
}

function rawSectionMap(plan) {
  const map = new Map();
  for (const s of plan.itinerary.sections) map.set(Number(s.id), s);
  return map;
}

// ---------- desired: resolution of section ids, landed writes, matched app blocks ----------

// Fills `id: null` sections (existing day, Notes and Hotels sections before the first lock) by
// date or type, and marks `new` sections, blocks and rows whose id is already in Wanderlog in
// the same place as landed (a write that went through). Any other reuse of an id is refused.
export function resolveDesired(doc, desired) {
  if (!desired) return { desired: null, resolved: {}, refusals: [] };
  const plan = tripPlanOf(doc);
  const out = clone(desired);
  const resolved = {};
  const refusals = [];
  const sections = plan.itinerary.sections;
  const where = new Map(); // id -> {kind, section, block}
  for (const s of sections) {
    where.set(Number(s.id), { kind: 'section', section: Number(s.id) });
    for (const b of s.blocks || []) {
      where.set(Number(b.id), { kind: 'block', section: Number(s.id) });
      for (const row of b.items || []) where.set(Number(row.id), { kind: 'row', section: Number(s.id), block: Number(b.id) });
    }
  }
  for (const s of out.sections) {
    if (s.id == null && !s.new) {
      let found = [];
      if (s.key.startsWith('day:')) found = sections.filter(x => x.mode === 'dayPlan' && x.date === s.key.slice(4));
      else if (s.type === 'textOnly' || NATIVE_SECTIONS[s.type]) found = sections.filter(x => x.type === s.type && x.mode === s.mode);
      if (found.length === 1) {
        s.id = Number(found[0].id);
        resolved[s.key] = s.id;
      } else if (found.length > 1) {
        refusals.push(`desired section ${s.key} matches ${found.length} Wanderlog sections`);
      }
    } else if (s.new && where.has(s.id)) {
      const at = where.get(s.id);
      const raw = sections.find(x => Number(x.id) === s.id);
      if (at.kind === 'section' && raw.type === s.type && raw.mode === s.mode) {
        s.new = false;
        resolved[s.key] = s.id;
      } else {
        refusals.push(`new section ${s.key} id ${s.id} is already used in Wanderlog`);
      }
    } else if (s.new && NATIVE_SECTIONS[s.type]) {
      // A trip has at most one Hotels (Flights, Transit, Rental cars) section: an existing one
      // takes the new one's place.
      const found = sections.filter(x => x.type === s.type && x.mode === s.mode);
      if (found.length === 1) {
        s.id = Number(found[0].id);
        s.new = false;
        resolved[s.key] = s.id;
      } else if (found.length > 1) {
        refusals.push(`desired section ${s.key} matches ${found.length} Wanderlog sections`);
      }
    }
    for (const b of s.blocks) {
      if (b.new && where.has(b.id)) {
        const at = where.get(b.id);
        if (at.kind === 'block' && at.section === s.id && !s.new) b.new = false;
        else refusals.push(`new block ${b.key} id ${b.id} is already used in Wanderlog`);
      }
      for (const row of b.items || []) {
        if (row.new && where.has(row.id)) {
          const at = where.get(row.id);
          if (at.kind === 'row' && at.block === b.id && !b.new) row.new = false;
          else refusals.push(`new checklist row ${b.key}/${row.key} id ${row.id} is already used in Wanderlog`);
        }
      }
    }
  }
  return { desired: out, resolved, refusals };
}

// A desired new block equal (ids aside) to an unmapped Wanderlog block in the same section takes
// that block's id and row ids: an app-added block the owner adopted.
export function matchNew(doc, desired, lock) {
  if (!desired) return { desired: null, matched: {} };
  const raw = rawSectionMap(tripPlanOf(doc));
  const out = clone(desired);
  const known = new Set(Object.values(lock?.entries || {}).map(e => Number(e.block)));
  for (const s of out.sections) for (const b of s.blocks) if (!b.new) known.add(b.id);
  const matched = {};
  for (const s of out.sections) {
    const rawSection = !s.new ? raw.get(s.id) : null;
    const free = (rawSection?.blocks || []).filter(b => BLOCK_TYPES.includes(b.type) && !known.has(Number(b.id))).map(normBlock);
    for (const b of s.blocks) {
      if (!b.new) continue;
      const want = canon(noIds(strip(b)));
      const index = free.findIndex(w => canon(noIds(w)) === want);
      if (index === -1) continue;
      const [hit] = free.splice(index, 1);
      b.id = hit.id;
      b.new = false;
      const rows = {};
      (b.items || []).forEach((row, i) => {
        row.id = hit.items[i].id;
        row.new = false;
        rows[row.key] = row.id;
      });
      matched[b.key] = { id: hit.id, ...(Object.keys(rows).length ? { rows } : {}) };
    }
  }
  return { desired: out, matched };
}

// ---------- diff, drift, refusals (contract "Drift classification") ----------

export function analyse(doc, desired = null, lock = null) {
  const resolution = resolveDesired(doc, desired);
  const { desired: matchedDesired, matched } = matchNew(doc, resolution.desired, lock);
  const result = analyseCore(doc, matchedDesired, lock);
  result.refusals = [...new Set([...result.refusals, ...resolution.refusals])].sort(byString);
  result.matched = matched;
  result.resolved = resolution.resolved;
  result.desired = matchedDesired;
  return result;
}

function analyseCore(doc, desired, lockIn) {
  const plan = tripPlanOf(doc);
  const raw = rawSectionMap(plan);
  const refusals = [];
  const ops = [];
  const drift = [];
  const hashes = { entries: {}, sections: {} };
  const ids = plan.itinerary.sections.map(s => Number(s.id));
  if (ids.length !== new Set(ids).size) refusals.push('duplicate section id in Wanderlog');
  const lock = lockIn || { sections: {}, entries: {} };
  const locked = lock.sections || {};
  const entries = lock.entries || {};
  const managed = new Set(Object.values(locked).map(Number));
  const dSections = desired?.sections || [];
  for (const s of dSections) if (s.id && !s.new) managed.add(s.id);

  const wBlocks = new Map();
  for (const sid of managed) {
    const section = raw.get(sid);
    if (!section) continue;
    if (!SECTION_SHAPES.has(`${section.type}/${section.mode}`)) refusals.push(`unknown section shape ${section.type}/${section.mode} for managed section ${sid}`);
    for (const block of section.blocks || []) {
      if (!blockTypesFor(section.type).includes(block.type)) {
        refusals.push(`unknown block type ${pyRepr(block.type)} in managed section ${sid}`);
        continue;
      }
      wBlocks.set(Number(block.id), [sid, normBlock(block)]);
    }
  }
  for (const [key, sid] of Object.entries(locked).sort(([a], [b]) => byString(a, b))) {
    const section = raw.get(Number(sid));
    if (!section) refusals.push(`locked section ${key} is missing in Wanderlog`);
    else if (key.startsWith('day:') && section.date !== key.slice(4)) refusals.push(`locked day section ${key} now has date ${pyStr(section.date)}`);
  }
  if (desired) {
    const wDays = [...raw.values()].filter(s => s.mode === 'dayPlan').length;
    const dDays = dSections.filter(s => s.mode === 'dayPlan').length;
    if (wDays !== dDays) refusals.push(`Wanderlog has ${wDays} day sections, desired has ${dDays}`);
  }
  const missingMapped = Object.values(entries).filter(e => !wBlocks.has(Number(e.block)));
  if (missingMapped.length > MAX_MISSING) refusals.push(`${missingMapped.length} mapped blocks are missing (wrong trip or wipe)`);

  const byBlock = new Map(Object.entries(entries).map(([k, e]) => [Number(e.block), k]));
  const dBlocks = new Map();
  for (const s of dSections) {
    for (const b of s.blocks) {
      dBlocks.set(b.key, [s.key, strip(b)]);
      if (!byBlock.has(b.id)) byBlock.set(b.id, b.key);
    }
  }
  for (const [bid, [, block]] of wBlocks) if (byBlock.has(bid)) hashes.entries[byBlock.get(bid)] = sha(block);
  const keyOfSection = new Map(Object.entries(locked).map(([k, sid]) => [Number(sid), k]));
  for (const s of dSections) if (s.id) keyOfSection.set(s.id, s.key);
  const wSummaries = {};
  for (const sid of managed) {
    const section = raw.get(sid);
    if (section && keyOfSection.has(sid)) {
      const summary = sectionSummary(sid, section, (section.blocks || []).map(b => Number(b.id)));
      wSummaries[keyOfSection.get(sid)] = summary;
      hashes.sections[keyOfSection.get(sid)] = sha(summary);
    }
  }

  if (desired) {
    for (const s of dSections) {
      const key = s.key;
      const dSummary = sectionSummary(s.id, s, s.blocks.map(b => b.id));
      if (s.id == null) {
        refusals.push(`desired section ${key} has no Wanderlog id`);
        continue;
      }
      if (s.new) {
        ops.push({ op: 'insert_section', section: key, blocks: s.blocks.map(b => b.key) });
        continue;
      }
      if (!raw.has(s.id)) continue;
      const w = wSummaries[key];
      if (w.heading !== dSummary.heading) ops.push({ op: 'set_heading', section: key });
      if ('text' in dSummary && !same(w.text, dSummary.text)) ops.push({ op: 'set_text', section: key });
      const changed = s.blocks.filter(b => !wBlocks.has(b.id) || !same(wBlocks.get(b.id)[1], strip(b)) || wBlocks.get(b.id)[0] !== s.id).map(b => b.key);
      if (changed.length || !same(w.blocks, dSummary.blocks)) {
        const wanted = new Set(dSummary.blocks);
        ops.push({ op: 'replace_blocks', section: key, changed, removed: [...new Set(w.blocks.filter(id => !wanted.has(id)))].sort((a, b) => a - b) });
      }
    }
    const dKeys = new Set(dSections.map(s => s.key));
    for (const key of Object.keys(locked).filter(k => !dKeys.has(k)).sort(byString)) ops.push({ op: 'delete_section', section: key });
  }

  const item = (key, kind, field, wValue, dValue, last, section) => {
    const record = { key, kind, field, wanderlog: wValue ?? null, file: dValue ?? null, last_hash: last ?? null, fingerprint: sha([key, kind, field, wValue ?? null]) };
    if (section) record.section = section;
    drift.push(record);
  };
  if (Object.keys(entries).length || Object.keys(locked).length) {
    for (const [key, entry] of Object.entries(entries).sort(([a], [b]) => byString(a, b))) {
      const d = desired ? (dBlocks.get(key)?.[1] ?? null) : null;
      const found = wBlocks.get(Number(entry.block));
      const sectionKey = found ? keyOfSection.get(found[0]) : null;
      if (!found) {
        if (desired && d === null) continue; // removed in the file and in the app
        item(key, 'missing', '*', null, d, entry.hash);
        continue;
      }
      const w = found[1];
      if (sha(w) === entry.hash) continue;
      if (d !== null && same(w, d)) continue; // already matches the file
      if (d === null) {
        item(key, 'changed', '*', w, null, entry.hash, sectionKey);
        continue;
      }
      for (const field of [...new Set([...Object.keys(w), ...Object.keys(d)])].sort(byString)) {
        if (!same(w[field], d[field])) item(key, 'changed', field, w[field], d[field], entry.hash, sectionKey);
      }
    }
    const known = new Set([...Object.values(entries).map(e => Number(e.block)), ...[...dBlocks.values()].map(([, b]) => b.id)]);
    for (const [bid, [sid, block]] of [...wBlocks].sort(([a], [b]) => a - b)) {
      if (!known.has(bid)) item(`block:${bid}`, 'added', '*', block, null, null, keyOfSection.get(sid));
    }
    const lastSections = lock.section_hashes || {};
    const dSummaries = Object.fromEntries(dSections.map(s => [s.key, sectionSummary(s.id, s, s.blocks.map(b => b.id))]));
    for (const key of Object.keys(locked).sort(byString)) {
      const w = wSummaries[key];
      if (!w || sha(w) === lastSections[key]) continue;
      const d = desired ? (dSummaries[key] ?? null) : null;
      if (d !== null && same(w, d)) continue;
      for (const field of ['heading', 'text', 'blocks']) {
        if (field in w && (d === null || !same(w[field], d[field]))) {
          item(key, 'changed', field === 'blocks' ? 'order' : field, w[field], d === null ? null : d[field], lastSections[key]);
        }
      }
    }
  }
  drift.sort((a, b) => byString(a.key, b.key) || byString(a.field, b.field));
  return { version: plan.overallVersion, ops, op_count: ops.length, drift, refusals: [...new Set(refusals)].sort(byString), hashes };
}

// ---------- native blocks and the pre-post schema check ----------

// The field set Wanderlog's own web UI gives a new block (spike evidence 01/02-native-shapes).
export function nativeBlock(desiredBlock, owner) {
  const out = { id: desiredBlock.id, type: desiredBlock.type, addedBy: { type: 'user', userId: owner }, attachments: [] };
  if (desiredBlock.type === 'place') Object.assign(out, { imageSize: 'small', upvotedBy: [], travelMode: null, imageKeys: [] });
  if (desiredBlock.type === 'flight') out.travelerNames = [];
  return out;
}

// A Google place written into a block: modelled fields from desired; the old place's other
// fields are kept only while its Google id is unchanged.
function writePlace(oldPlace, want, defaultTypes) {
  let place = oldPlace && typeof oldPlace === 'object' && !Array.isArray(oldPlace) ? clone(oldPlace) : {};
  if ((place.place_id ?? null) !== (want.place_id ?? null)) place = {};
  place = Object.fromEntries(Object.entries(place).filter(([k]) => !PLACE_FIELDS.includes(k)));
  for (const [k, v] of Object.entries(want)) if (k !== 'geometry') place[k] = clone(v);
  place.geometry = { ...(place.geometry || {}), location: clone(want.geometry.location) };
  if (!('place_id' in place)) place.place_id = null;
  if (!Array.isArray(place.types)) place.types = defaultTypes;
  return place;
}

const objectOr = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

// Reservation endpoints (flight depart/arrive, train depart/arrive, car pickUp/dropOff): every
// endpoint field the web app writes is present, null when unset.
function writeEndpoint(old, want, extra) {
  return { ...objectOr(old), ...extra, date: want.date ?? null, time: want.time ?? null };
}

// Fills bookkeeping fields a rewritten block lacks (older CLI blocks have no imageKeys), so no
// written block ever carries less than a native one. Present values are never changed.
function fillRequired(raw, owner) {
  if (!raw.addedBy || typeof raw.addedBy !== 'object') raw.addedBy = { type: 'user', userId: owner };
  if (!Array.isArray(raw.attachments)) raw.attachments = [];
  if (raw.type === 'place') {
    if (typeof raw.imageSize !== 'string') raw.imageSize = 'small';
    if (!Array.isArray(raw.upvotedBy)) raw.upvotedBy = [];
    if (!('travelMode' in raw)) raw.travelMode = null;
    if (!Array.isArray(raw.imageKeys)) raw.imageKeys = [];
  }
  if (raw.type === 'flight' && !Array.isArray(raw.travelerNames)) raw.travelerNames = [];
  return raw;
}

// Desired block (normal form) -> raw Wanderlog block. An existing block keeps every field the
// plan does not model; if its Google place id changed, the old Google fields are dropped.
export function writeBlock(d, old, owner) {
  const raw = old && old.type === d.type ? clone(old) : nativeBlock(d, owner);
  raw.id = d.id;
  if (d.type === 'place') {
    raw.place = writePlace(raw.place, d.place, ['point_of_interest']);
    raw.text = clone(d.text);
    for (const name of ['startTime', 'endTime']) {
      if (d[name]) raw[name] = d[name];
      else if (name in raw) raw[name] = null;
    }
    raw.travelMode = d.travelMode ?? null;
    if (d.hotel) {
      raw.hotel = { ...(raw.hotel || {}), ...clone(d.hotel) };
      if (!Array.isArray(raw.hotel.travelerNames)) raw.hotel.travelerNames = [];
    } else {
      delete raw.hotel;
    }
  } else if (d.type === 'flight') {
    raw.text = clone(d.text);
    raw.confirmationNumber = d.confirmationNumber ?? '';
    raw.flightInfo = { ...objectOr(raw.flightInfo), airline: clone(d.flightInfo.airline), number: d.flightInfo.number };
    for (const side of ['depart', 'arrive']) {
      const want = d[side];
      const oldAirport = objectOr(raw[side]?.airport);
      raw[side] = writeEndpoint(raw[side], want, {
        type: side,
        airport: {
          ...oldAirport, iata: want.airport.iata, name: want.airport.name, cityName: want.airport.cityName,
          googlePlace: writePlace(oldAirport.googlePlace, want.airport.googlePlace, ['airport']),
        },
      });
    }
  } else if (d.type === 'train') {
    raw.text = clone(d.text);
    raw.confirmationNumber = d.confirmationNumber ?? '';
    raw.carrier = d.carrier ?? '';
    for (const side of ['depart', 'arrive']) {
      raw[side] = writeEndpoint(raw[side], d[side], { place: writePlace(raw[side]?.place, d[side].place, ['train_station']) });
    }
  } else if (d.type === 'rentalCar') {
    raw.text = clone(d.text);
    if (d.confirmationNumber) raw.confirmationNumber = d.confirmationNumber;
    else if ('confirmationNumber' in raw) raw.confirmationNumber = '';
    for (const side of ['pickUp', 'dropOff']) {
      raw[side] = writeEndpoint(raw[side], d[side], {
        airportOrGeo: clone(d[side].airportOrGeo),
        place: writePlace(raw[side]?.place, d[side].place, ['locality']),
      });
    }
  } else if (d.type === 'note') {
    raw.text = clone(d.text);
  } else if (d.type === 'checklist') {
    raw.title = d.title;
    const oldRows = new Map((raw.items || []).map(row => [Number(row.id), row]));
    raw.items = d.items.map(row => ({ ...(oldRows.get(row.id) || {}), id: row.id, checked: row.checked, text: clone(row.text) }));
  }
  return fillRequired(raw, owner);
}

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const isOps = text => isObject(text) && Array.isArray(text.ops) && text.ops.length > 0;

// Missing or malformed required fields of one written block (empty list = complete).
export function checkBlockSchema(block) {
  const missing = [];
  const need = (ok, field) => { if (!ok) missing.push(field); };
  need(Number.isInteger(block?.id), 'id');
  need(BLOCK_TYPES.includes(block?.type), 'type');
  // Web-created blocks store userId as a number; blocks from older CLI add commands store the same
  // id as a digit-only string, which Wanderlog accepts. Both pass; an existing addedBy is never rewritten.
  const userId = block?.addedBy?.userId;
  need(isObject(block?.addedBy) && typeof block.addedBy.type === 'string'
    && (Number.isInteger(userId) || (typeof userId === 'string' && /^\d+$/.test(userId))), 'addedBy');
  need(Array.isArray(block?.attachments), 'attachments');
  const needPlace = (place, at) => {
    need(isObject(place), at);
    need(typeof place?.name === 'string' && place.name.length > 0, `${at}.name`);
    need(Number.isFinite(place?.geometry?.location?.lat) && Number.isFinite(place?.geometry?.location?.lng), `${at}.geometry.location`);
    need(typeof place?.formatted_address === 'string', `${at}.formatted_address`);
    need(isObject(place) && 'place_id' in place && (place.place_id === null || typeof place.place_id === 'string'), `${at}.place_id`);
    need(Array.isArray(place?.types), `${at}.types`);
  };
  // date YYYY-MM-DD, time null or HH:MM (the web app writes both keys).
  const needWhen = (end, at) => {
    need(isObject(end), at);
    need(DATE.test(end?.date ?? ''), `${at}.date`);
    need(isObject(end) && 'time' in end && (end.time === null || CLOCK.test(end.time)), `${at}.time`);
  };
  if (['flight', 'train', 'rentalCar'].includes(block?.type)) {
    need(isOps(block.text), 'text');
    if (block.type !== 'rentalCar' || 'confirmationNumber' in block) need(typeof block.confirmationNumber === 'string', 'confirmationNumber');
  }
  if (block?.type === 'flight') {
    const airline = block.flightInfo?.airline;
    need(isObject(airline) && ['iata', 'icao', 'name', 'localizedName'].every(k => typeof airline[k] === 'string' && airline[k].length > 0), 'flightInfo.airline');
    need(Number.isInteger(block.flightInfo?.number) || (typeof block.flightInfo?.number === 'string' && /^\d+$/.test(block.flightInfo.number)), 'flightInfo.number');
    need(Array.isArray(block.travelerNames), 'travelerNames');
    for (const side of ['depart', 'arrive']) {
      const end = block[side];
      needWhen(end, side);
      need(end?.type === side, `${side}.type`);
      need(isObject(end?.airport) && /^[A-Z0-9]{3}$/.test(end.airport.iata ?? '') && typeof end.airport.name === 'string' && end.airport.name.length > 0
        && typeof end.airport.cityName === 'string', `${side}.airport`);
      needPlace(end?.airport?.googlePlace, `${side}.airport.googlePlace`);
    }
  } else if (block?.type === 'train') {
    need(typeof block.carrier === 'string', 'carrier');
    for (const side of ['depart', 'arrive']) {
      needWhen(block[side], side);
      needPlace(block[side]?.place, `${side}.place`);
    }
  } else if (block?.type === 'rentalCar') {
    for (const side of ['pickUp', 'dropOff']) {
      needWhen(block[side], side);
      need(isObject(block[side]?.airportOrGeo) && typeof block[side].airportOrGeo.type === 'string' && isObject(block[side].airportOrGeo.value), `${side}.airportOrGeo`);
      needPlace(block[side]?.place, `${side}.place`);
    }
  }
  if (block?.type === 'place') {
    needPlace(block.place, 'place');
    need(isOps(block.text), 'text');
    need(typeof block.imageSize === 'string', 'imageSize');
    need(Array.isArray(block.upvotedBy), 'upvotedBy');
    need('travelMode' in block && (block.travelMode === null || TRAVEL_MODES.includes(block.travelMode)), 'travelMode');
    need(Array.isArray(block.imageKeys), 'imageKeys');
    for (const name of ['startTime', 'endTime']) need(block[name] == null || CLOCK.test(block[name]), name);
    if (block.hotel !== undefined) {
      need(isObject(block.hotel) && DATE.test(block.hotel.checkIn) && DATE.test(block.hotel.checkOut)
        && typeof block.hotel.confirmationNumber === 'string' && Array.isArray(block.hotel.travelerNames), 'hotel');
    }
  } else if (block?.type === 'note') {
    need(isOps(block.text), 'text');
  } else if (block?.type === 'checklist') {
    need(typeof block.title === 'string', 'title');
    need(Array.isArray(block.items) && block.items.every(row => Number.isInteger(row?.id) && typeof row.checked === 'boolean' && isOps(row.text)), 'items');
  }
  return missing;
}

// Refuses (exit 3, nothing written) a batch with any written block that is not byte-identical
// to a block already in Wanderlog (or the restore snapshot) and misses a required field.
export function assertBatchSchema(components, knownBlocks) {
  const known = new Set(knownBlocks.map(canon));
  const problems = [];
  const visit = block => {
    if (known.has(canon(block))) return;
    const missing = checkBlockSchema(block);
    if (missing.length) problems.push(`block ${block?.id ?? '?'} (${block?.type ?? '?'}) lacks ${missing.join(', ')}`);
  };
  for (const c of components) {
    const last = c.p.at(-1);
    if (last === 'blocks' && Array.isArray(c.oi)) c.oi.forEach(visit);
    if (c.li && Array.isArray(c.li.blocks)) c.li.blocks.forEach(visit);
    if (c.oi && c.p.at(-2) === 'blocks' && typeof last === 'number') visit(c.oi);
  }
  if (problems.length) throw new SyncExit(EXIT.refused, `Refusing a batch with incomplete blocks: ${problems.join('; ')}`, { refusals: problems });
}

// ---------- json0 subset (local simulation of a batch before it is posted) ----------

function walk(root, path) {
  let node = root;
  for (const step of path.slice(0, -1)) {
    if (node == null || typeof node !== 'object' || !(step in node)) throw new Error(`Cannot read properties of undefined (path ${path.join('.')})`);
    node = node[step];
  }
  return [node, path.at(-1)];
}

// Applies the components Wanderlog's applyOps takes here (od/oi, li/ld, text0 compares) to
// `root` (the tripPlan object) in place. Throws with the server's wording on a failed compare.
export function applyJson0(root, components) {
  for (const c of components) {
    const [parent, key] = walk(root, c.p);
    if (c.t === 'text0') {
      let text = parent?.[key];
      if (typeof text !== 'string') throw new Error(`Cannot read properties of undefined (text0 at ${c.p.join('.')})`);
      for (const o of c.o) {
        if ('d' in o) {
          if (text.slice(o.p, o.p + o.d.length) !== o.d) throw new Error('Delete component does not match deleted text');
          text = text.slice(0, o.p) + text.slice(o.p + o.d.length);
        }
        if ('i' in o) text = text.slice(0, o.p) + o.i + text.slice(o.p);
      }
      parent[key] = text;
    } else if ('li' in c || 'ld' in c) {
      if (!Array.isArray(parent)) throw new Error(`Cannot read properties of undefined (list at ${c.p.join('.')})`);
      if ('ld' in c) {
        if (key >= parent.length) throw new Error('Index out of bounds');
        if ('li' in c) parent[key] = clone(c.li);
        else parent.splice(key, 1);
      } else {
        if (key > parent.length) throw new Error('Index out of bounds');
        parent.splice(key, 0, clone(c.li));
      }
    } else if ('oi' in c || 'od' in c) {
      if (parent == null || typeof parent !== 'object') throw new Error(`Cannot read properties of undefined (object at ${c.p.join('.')})`);
      if ('oi' in c) parent[key] = clone(c.oi);
      else delete parent[key];
    } else {
      throw new Error(`Unsupported op component at ${c.p.join('.')}`);
    }
  }
  return root;
}

// ---------- batch building ----------

const sectionPath = (index, ...tail) => ['itinerary', 'sections', index, ...tail];

export function textCompare(path, text) {
  return { p: path, t: 'text0', o: [{ p: 0, d: text }, { p: 0, i: text }] };
}

// Pre-state compares for one section: its heading and day date, and one identity string per
// current block, so a batch computed from a stale fetch is refused as a whole.
function sectionCompares(section, si) {
  const out = [];
  if (typeof section.heading === 'string') out.push(textCompare(sectionPath(si, 'heading'), section.heading));
  if (section.mode === 'dayPlan' && typeof section.date === 'string') out.push(textCompare(sectionPath(si, 'date'), section.date));
  (section.blocks || []).forEach((b, bi) => {
    if (b.type === 'place' && typeof b.place?.name === 'string') out.push(textCompare(sectionPath(si, 'blocks', bi, 'place', 'name'), b.place.name));
    else if (b.type === 'note' && typeof b.text?.ops?.[0]?.insert === 'string') out.push(textCompare(sectionPath(si, 'blocks', bi, 'text', 'ops', 0, 'insert'), b.text.ops[0].insert));
    else if (b.type === 'checklist' && typeof b.title === 'string') out.push(textCompare(sectionPath(si, 'blocks', bi, 'title'), b.title));
    else if (IDENTITY[b.type]) {
      // Reservation blocks: their identity strings (a flight number is a number, so the airline
      // code and the departure date stand in for it; text0 compares strings only).
      for (const path of IDENTITY[b.type]) {
        const value = path.reduce((node, step) => node?.[step], b);
        if (typeof value === 'string') out.push(textCompare(sectionPath(si, 'blocks', bi, ...path), value));
      }
    }
  });
  return out;
}

const IDENTITY = {
  flight: [['depart', 'airport', 'iata'], ['flightInfo', 'airline', 'iata'], ['flightInfo', 'number'], ['depart', 'date']],
  train: [['depart', 'place', 'name'], ['depart', 'date']],
  rentalCar: [['pickUp', 'place', 'name'], ['pickUp', 'date']],
};

function replace(path, holder, key, value) {
  return key in holder ? { p: path, od: holder[key], oi: value } : { p: path, oi: value };
}

// Native Hotels, Flights, Rental cars and Transit sections, as the web app makes them (and
// src/lodging.mjs for Hotels): no date key.
function newNativeSection(d, blocks) {
  const { placeMarkerColor, placeMarkerIcon } = NATIVE_SECTIONS[d.type];
  return {
    id: d.id, heading: d.heading, type: d.type, mode: 'placeList', blocks,
    text: { ops: [{ insert: '\n' }] }, placeMarkerColor, placeMarkerIcon,
  };
}

// Where the web app puts a native section: after Notes and the native sections it ranks below
// (Flights, Hotels, Rental cars, Transit), else before the first native section ranked above
// it, else before the first day.
function nativeIndex(sections, type) {
  const rank = NATIVE_SECTIONS[type].rank;
  const rankOf = s => (s.type === 'textOnly' ? 0 : NATIVE_SECTIONS[s.type]?.rank);
  let after = -1;
  sections.forEach((s, i) => { if (rankOf(s) !== undefined && rankOf(s) < rank) after = i; });
  if (after !== -1) return after + 1;
  const above = sections.findIndex(s => NATIVE_SECTIONS[s.type] && NATIVE_SECTIONS[s.type].rank > rank);
  if (above !== -1) return above;
  const day = sections.findIndex(s => s.mode === 'dayPlan');
  return day === -1 ? sections.length : day;
}

function newListSection(d, blocks) {
  return {
    id: d.id, heading: d.heading, type: 'normal', mode: 'placeList', blocks, date: null,
    text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#3f52e3', placeMarkerIcon: 'map-marker',
  };
}

// Batch components (compares first, then writes in index order) that turn `doc` into `desired`
// (already resolved and matched). Also returns the contract-level op count.
export function buildApplyBatch(doc, desired, lock) {
  const plan = tripPlanOf(doc);
  const owner = plan.userId;
  if (!Number.isInteger(owner)) throw new SyncExit(EXIT.refused, 'Trip owner userId is unavailable; refusing to build blocks without addedBy');
  const sections = plan.itinerary.sections;
  const index = new Map(sections.map((s, i) => [Number(s.id), i]));
  const oldBlocks = new Map();
  for (const s of sections) for (const b of s.blocks || []) oldBlocks.set(Number(b.id), b);
  const touched = new Set();
  const writes = [];
  const inserts = [];
  const nativeInserts = new Map();
  const deletes = [];
  for (const d of desired.sections) {
    const blocksFor = existing => d.blocks.map(b => {
      const want = strip(b);
      const old = existing ? oldBlocks.get(b.id) : undefined;
      if (old && same(normBlock(old), want)) return old;
      return writeBlock(want, old, owner);
    });
    if (d.new) {
      if (NATIVE_SECTIONS[d.type] && d.mode === 'placeList' && !nativeInserts.has(d.type)) {
        nativeInserts.set(d.type, newNativeSection(d, blocksFor(false)));
        continue;
      }
      if (d.type !== 'normal' || d.mode !== 'placeList') throw new SyncExit(EXIT.refused, `Only normal list, Hotels, Flights, Rental cars and Transit sections are created; ${d.key} is ${d.type}/${d.mode}`);
      inserts.push(newListSection(d, blocksFor(false)));
      continue;
    }
    const si = index.get(d.id);
    const raw = sections[si];
    const before = writes.length;
    if ((raw.heading ?? '') !== (d.heading ?? '')) writes.push({ si, c: replace(sectionPath(si, 'heading'), raw, 'heading', d.heading) });
    if (d.text !== undefined && !same(textOf(raw.text), textOf(d.text))) writes.push({ si, c: replace(sectionPath(si, 'text'), raw, 'text', clone(d.text)) });
    const blocks = blocksFor(true);
    if (!same(raw.blocks || [], blocks)) writes.push({ si, c: replace(sectionPath(si, 'blocks'), raw, 'blocks', clone(blocks)) });
    if (writes.length > before) touched.add(si);
  }
  // Moved blocks: a section that loses a block it still lists is rewritten by its own entry above.
  const dKeys = new Set(desired.sections.map(s => s.key));
  for (const [key, sid] of Object.entries(lock?.sections || {})) {
    if (dKeys.has(key)) continue;
    const si = index.get(Number(sid));
    if (si === undefined) continue;
    const raw = sections[si];
    if (raw.type !== 'normal' || raw.mode !== 'placeList') throw new SyncExit(EXIT.refused, `Refusing to delete ${key}: only normal list sections are deleted (it is ${raw.type}/${raw.mode})`);
    deletes.push(si);
    touched.add(si);
  }
  const compares = [...touched].sort((a, b) => a - b).flatMap(si => sectionCompares(sections[si], si));
  const components = [...compares, ...writes.sort((a, b) => a.si - b.si).map(w => w.c)];
  deletes.sort((a, b) => b - a);
  for (const si of deletes) components.push({ p: sectionPath(si), ld: sections[si] });
  const remaining = sections.filter((_, i) => !deletes.includes(i));
  for (const section of [...nativeInserts.values()].sort((a, b) => NATIVE_SECTIONS[a.type].rank - NATIVE_SECTIONS[b.type].rank)) {
    const at = nativeIndex(remaining, section.type);
    components.push({ p: sectionPath(at), li: section });
    remaining.splice(at, 0, section);
  }
  const firstDay = remaining.findIndex(s => s.mode === 'dayPlan');
  let at = firstDay === -1 ? remaining.length : firstDay;
  for (const section of inserts) components.push({ p: sectionPath(at++), li: section });
  return { components, knownBlocks: [...oldBlocks.values()] };
}

// Restore: managed sections (last ∪ target lock) present in the snapshot get the snapshot's raw
// content back; managed sections absent from it are deleted; others stay untouched.
export function buildRestoreBatch(doc, snapshot, last, target) {
  const sections = tripPlanOf(doc).itinerary.sections;
  const pre = tripPlanOf(snapshot).itinerary.sections;
  const preById = new Map(pre.map(s => [Number(s.id), s]));
  const managed = new Set([...Object.values(last?.sections || {}), ...Object.values(target?.sections || {})].map(Number));
  const touched = new Set();
  const writes = [];
  const deletes = [];
  let changedSections = 0;
  sections.forEach((s, si) => {
    const sid = Number(s.id);
    if (!managed.has(sid)) return;
    const want = preById.get(sid);
    if (!want) {
      if (s.mode === 'dayPlan' || s.type !== 'normal') throw new SyncExit(EXIT.refused, `Refusing to delete section ${sid} (${s.type}/${s.mode}) that the snapshot lacks`);
      deletes.push(si);
      touched.add(si);
      changedSections += 1;
      return;
    }
    let changed = false;
    for (const key of [...new Set([...Object.keys(s), ...Object.keys(want)])].filter(k => k !== 'id').sort(byString)) {
      if (same(s[key], want[key]) && (key in s) === (key in want)) continue;
      changed = true;
      if (key in want) writes.push({ si, c: replace(sectionPath(si, key), s, key, clone(want[key])) });
      else writes.push({ si, c: { p: sectionPath(si, key), od: s[key] } });
    }
    if (changed) {
      touched.add(si);
      changedSections += 1;
    }
  });
  const present = new Set(sections.filter((s, i) => !deletes.includes(i)).map(s => Number(s.id)));
  const finalList = sections.filter((_, i) => !deletes.includes(i)).map(s => ({ id: Number(s.id), insert: null }));
  pre.forEach((s, i) => {
    const sid = Number(s.id);
    if (managed.has(sid) && !present.has(sid)) {
      finalList.splice(Math.min(i, finalList.length), 0, { id: sid, insert: s });
      changedSections += 1;
    }
  });
  const compares = [...touched].sort((a, b) => a - b).flatMap(si => sectionCompares(sections[si], si));
  const components = [...compares, ...writes.sort((a, b) => a.si - b.si).map(w => w.c)];
  for (const si of deletes.sort((a, b) => b - a)) components.push({ p: sectionPath(si), ld: sections[si] });
  finalList.forEach((entry, i) => { if (entry.insert) components.push({ p: sectionPath(i), li: clone(entry.insert) }); });
  const knownBlocks = [...sections, ...pre].flatMap(s => s.blocks || []);
  return { components, knownBlocks, changedSections };
}

// ---------- redaction ----------

// Every access key in a fetched trip document, wherever it sits, is replaced by [REDACTED]:
// editKey, viewKey, suggestKey, journalKey, and each TripPlanKeys row's key.
export function redactTripDoc(doc) {
  const visit = (value, name) => {
    if (Array.isArray(value)) {
      if (name === 'TripPlanKeys') return value.map(row => (isObject(row) ? { ...visit(row), key: REDACTED } : REDACTED));
      return value.map(v => visit(v));
    }
    if (isObject(value)) {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = SECRET_FIELDS.includes(k) && v != null ? REDACTED : visit(v, k);
      return out;
    }
    if (name === 'TripPlanKeys' && value != null) return REDACTED;
    return value;
  };
  return visit(doc);
}

// ---------- local verification of a batch ----------

export function simulate(doc, components) {
  const out = clone(doc);
  applyJson0(tripPlanOf(out), components);
  return out;
}

export function structureErrors(doc) {
  return validateTripPlanStructure(doc).errors;
}
