// Calendar events published from the trip files (plan §13). The Worker stores a
// validated document per subscription and serves it without fetching Wanderlog.
// The CLI imports this module so `wlog calendar render` and the feed share one
// validator and one serialiser. Schema: docs/calendar-events.md.
import { generateIcs } from './ics-generator.mjs';

export const EVENTS_SCHEMA = 'wanderlog-calendar-events/1';
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_EVENTS = 1000;
const MAX_UID = 200;
const MAX_TITLE = 300;
const MAX_TEXT = 500;
const MAX_DESCRIPTION = 8000;
// Same namespace as the Wanderlog-derived events; see ics-generator.mjs.
const UID_NAMESPACE = 'wanderlog-calendar';

const TRIP_KEY_RE = /^[A-Za-z0-9_-]{1,100}$/;
const UID_TAIL_RE = /^[A-Za-z0-9._-]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/;
const DOC_KEYS = new Set(['schema', 'trip_key', 'title', 'events']);
const EVENT_KEYS = new Set(['uid', 'title', 'all_day', 'busy', 'date', 'start', 'end', 'tz', 'location', 'description']);
const LOCATION_KEYS = new Set(['name', 'address', 'lat', 'lng']);

export function tripEventsKey(planId) {
  return `trip:${planId}:events`;
}

// Returns { ok: true, doc } with a normalised copy, or { ok: false, errors }.
// `planId`, when given, must equal doc.trip_key.
export function validateEventsDocument(input, { planId = null } = {}) {
  const errors = [];
  const err = (path, message) => errors.push(`${path}: ${message}`);

  if (!isPlainObject(input)) return { ok: false, errors: ['$: must be an object'] };
  for (const key of Object.keys(input)) if (!DOC_KEYS.has(key)) err(`$.${key}`, 'unknown key');
  if (input.schema !== EVENTS_SCHEMA) err('$.schema', `must be "${EVENTS_SCHEMA}"`);
  const tripKey = input.trip_key;
  if (typeof tripKey !== 'string' || !TRIP_KEY_RE.test(tripKey)) err('$.trip_key', 'must match [A-Za-z0-9_-]{1,100}');
  else if (planId != null && tripKey !== planId) err('$.trip_key', `must equal the subscription planId "${planId}"`);
  if (input.title !== undefined && input.title !== null) checkString(input.title, '$.title', MAX_TITLE, err, { required: true });
  if (!Array.isArray(input.events)) err('$.events', 'must be an array');
  else if (input.events.length > MAX_EVENTS) err('$.events', `at most ${MAX_EVENTS} events`);
  if (errors.length) return { ok: false, errors };

  const seen = new Set();
  const events = input.events.map((event, index) => normaliseEvent(event, `$.events[${index}]`, tripKey, seen, err));
  if (errors.length) return { ok: false, errors };
  const doc = { schema: EVENTS_SCHEMA, trip_key: tripKey };
  if (input.title != null) doc.title = input.title;
  doc.events = events;
  return { ok: true, doc };
}

function normaliseEvent(event, path, tripKey, seen, err) {
  if (!isPlainObject(event)) {
    err(path, 'must be an object');
    return null;
  }
  for (const key of Object.keys(event)) if (!EVENT_KEYS.has(key)) err(`${path}.${key}`, 'unknown key');

  const prefix = `tf-${tripKey}-`;
  const { uid } = event;
  if (typeof uid !== 'string' || uid.length > MAX_UID || !uid.startsWith(prefix) || !UID_TAIL_RE.test(uid.slice(prefix.length))) {
    err(`${path}.uid`, `must be "${prefix}<id>" with id in [A-Za-z0-9._-], at most ${MAX_UID} chars`);
  } else if (seen.has(uid)) {
    err(`${path}.uid`, 'duplicate uid');
  } else {
    seen.add(uid);
  }
  checkString(event.title, `${path}.title`, MAX_TITLE, err, { required: true });
  if (event.busy !== undefined && typeof event.busy !== 'boolean') err(`${path}.busy`, 'must be true or false');
  if (event.description !== undefined && event.description !== null) {
    checkString(event.description, `${path}.description`, MAX_DESCRIPTION, err, { required: false });
  }

  const out = { uid, title: event.title, all_day: event.all_day };
  if (event.busy !== undefined) out.busy = event.busy;
  if (event.all_day === true) {
    for (const key of ['start', 'end', 'tz']) if (event[key] !== undefined) err(`${path}.${key}`, 'not allowed when all_day is true');
    if (!isRealDate(event.date)) err(`${path}.date`, 'must be a YYYY-MM-DD date');
    out.date = event.date;
  } else if (event.all_day === false) {
    if (event.date !== undefined) err(`${path}.date`, 'not allowed when all_day is false');
    const start = parseLocalDateTime(event.start);
    const end = parseLocalDateTime(event.end);
    if (!start) err(`${path}.start`, 'must be a YYYY-MM-DDTHH:MM local time');
    if (!end) err(`${path}.end`, 'must be a YYYY-MM-DDTHH:MM local time');
    if (start && end && event.end <= event.start) err(`${path}.end`, 'must be after start');
    if (!isTimeZone(event.tz)) err(`${path}.tz`, 'must be an IANA time zone');
    out.start = event.start;
    out.end = event.end;
    out.tz = event.tz;
  } else {
    err(`${path}.all_day`, 'must be true or false');
  }

  if (event.location !== undefined && event.location !== null) out.location = normaliseLocation(event.location, `${path}.location`, err);
  if (event.description != null) out.description = event.description;
  return out;
}

function normaliseLocation(location, path, err) {
  if (!isPlainObject(location)) {
    err(path, 'must be an object or null');
    return null;
  }
  for (const key of Object.keys(location)) if (!LOCATION_KEYS.has(key)) err(`${path}.${key}`, 'unknown key');
  const out = {};
  for (const key of ['name', 'address']) {
    if (location[key] === undefined || location[key] === null) continue;
    checkString(location[key], `${path}.${key}`, MAX_TEXT, err, { required: true });
    out[key] = location[key];
  }
  const hasLat = location.lat !== undefined && location.lat !== null;
  const hasLng = location.lng !== undefined && location.lng !== null;
  if (hasLat !== hasLng) err(path, 'lat and lng must be given together');
  if (hasLat && !(Number.isFinite(location.lat) && Math.abs(location.lat) <= 90)) err(`${path}.lat`, 'must be a number in [-90, 90]');
  if (hasLng && !(Number.isFinite(location.lng) && Math.abs(location.lng) <= 180)) err(`${path}.lng`, 'must be a number in [-180, 180]');
  if (hasLat && hasLng) {
    out.lat = location.lat;
    out.lng = location.lng;
  }
  return out;
}

// Validated document -> event objects understood by ics-generator's serialiser.
export function fileEventsToIcsEvents(doc) {
  const url = `https://wanderlog.com/plan/${doc.trip_key}`;
  return doc.events.map(event => {
    const location = event.location ?? {};
    const locationText = [...new Set([location.name, location.address].filter(Boolean))].join(', ');
    const common = {
      uid: `${event.uid}@${UID_NAMESPACE}`,
      summary: event.title,
      busy: event.busy,
      location: locationText,
      lat: location.lat,
      lng: location.lng,
      description: event.description ?? '',
      url,
    };
    if (event.all_day) {
      return { ...common, start: { kind: 'date', date: compact(event.date) }, end: { kind: 'date', date: compact(nextDay(event.date)) } };
    }
    return { ...common, start: localToDt(event.start, event.tz), end: localToDt(event.end, event.tz) };
  });
}

// A whole calendar for one events document; the CLI's local render.
export function renderEventsIcs(doc, { dtstamp, calendarVersion = '0.1.0', subscriptionVersion = 0 } = {}) {
  return generateIcs({ trips: [], extraEvents: fileEventsToIcsEvents(doc), dtstamp, calendarVersion, subscriptionVersion });
}

// VEVENT blocks (raw, folded text) whose UID belongs to `tripKey`'s file events,
// with DTSTAMP lines removed: the unit compared between a local render and the feed.
export function fileEventBlocks(ics, tripKey) {
  const prefix = `UID:tf-${tripKey}-`;
  const blocks = String(ics).match(/BEGIN:VEVENT\r\n[\s\S]*?END:VEVENT\r\n/g) ?? [];
  return blocks
    .filter(block => block.replace(/\r\n[ \t]/g, '').split('\r\n').some(line => line.startsWith(prefix)))
    .map(block => block.split('\r\n').filter(line => !line.startsWith('DTSTAMP:')).join('\r\n'));
}

function localToDt(value, timezone) {
  const [, date, hour, minute] = value.match(LOCAL_DT_RE);
  return { kind: 'dateTime', date: compact(date), time: `${hour}${minute}00`, timezone };
}

function parseLocalDateTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(LOCAL_DT_RE);
  if (!match || !isRealDate(match[1])) return null;
  if (Number(match[2]) > 23 || Number(match[3]) > 59) return null;
  return match;
}

function isRealDate(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(DATE_RE);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function isTimeZone(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function checkString(value, path, max, err, { required }) {
  if (typeof value !== 'string') return err(path, 'must be a string');
  if (required && value.trim() === '') return err(path, 'must not be empty');
  if (value.length > max) err(path, `at most ${max} characters`);
}

function nextDay(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

function compact(isoDate) {
  return isoDate.replaceAll('-', '');
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
