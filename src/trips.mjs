import { randomInt } from 'node:crypto';
import { createClient } from './client.mjs';
import { loadToken } from './token-store.mjs';
import { normalizeTrip, normalizeTripSummary } from './models.mjs';
import {
  AuthExpiredError, AuthRequiredError, ApiError, ConcurrentChangeError, ConfirmRequiredError, NotFoundError,
  TokenCorruptError, UsageError, VerificationError,
} from './errors.mjs';
import { assertTripPlanValid, validateTripPlanStructure } from './validation.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function listTrips(opts = {}) {
  const token = await loadToken(opts);
  if (!token) throw new AuthRequiredError();
  const userId = opts.userId || token.userId;
  if (!userId) throw new AuthRequiredError('No userId found in token. Run: wlog auth login --user-id <id>');
  const client = createClient({ ...opts, baseUrl: token.baseUrl });
  const data = await client.get(`/api/tripPlans?userId=${encodeURIComponent(userId)}`);
  const trips = unwrapTripList(data);
  return trips.map(normalizeTripSummary);
}

export async function getTrip(opts = {}, tripKey) {
  if (!tripKey) throw new Error('Usage: wlog trips get <tripKey>');
  const client = createClient(opts);
  const data = await client.get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
  return normalizeTrip(data);
}

export async function validateTrip(opts = {}, tripKey, validationOpts = {}) {
  if (!tripKey) throw new Error('Usage: wlog trips validate <tripKey>');
  const trip = await getTrip(opts, tripKey);
  return validateTripPlanStructure(trip.raw, validationOpts);
}

export async function debugFetch(opts = {}, tripKey) {
  if (!tripKey) throw new Error('Usage: wlog debug fetch <tripKey>');
  const client = createClient(opts);
  return client.get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
}

export async function createTrip(opts = {}, { destination, startDate = null, endDate = null } = {}) {
  if (!destination) throw new UsageError('Usage: wlog trips create <destination> [--start YYYY-MM-DD] [--end YYYY-MM-DD]');
  validateOptionalDate(startDate, 'startDate');
  validateOptionalDate(endDate, 'endDate');

  const matches = await searchDestination(opts, destination);
  if (matches.length === 0) throw new NotFoundError(`No destination found for: ${destination}`);
  const geoId = matches[0].id;
  if (geoId == null) throw new ApiError(`Top destination match is missing an id for: ${destination}`);

  const client = createClient(opts);
  // The body the web app sends (captured 2026-11-17). Without initialMapsPlaceIds the server
  // fails with "Cannot read properties of undefined (reading 'length')"; type must be 'plan'.
  const data = await client.post('/api/tripPlans', {
    geoIds: [geoId],
    initialMapsPlaceIds: [],
    initialSections: null,
    initialEmailId: null,
    type: 'plan',
    startDate: startDate || null,
    endDate: endDate || null,
    privacy: 'private',
    isMapEmbed: false,
    title: null,
    autogenerateItineraryOptions: null,
    language: 'en',
  });
  if (data?.success === false || !unwrapTripPayload(data)?.key) {
    throw new ApiError(`Wanderlog did not create the trip (${[].concat(data?.errTypes ?? 'no trip key in the response').join(', ')})`);
  }
  // The response is {success, data: {key, id, title, viewKey, createdSectionIds}}; viewKey is not returned.
  return normalizeTripSummary({ ...unwrapTripPayload(data), startDate: startDate || null, endDate: endDate || null });
}

export async function renameTrip(opts = {}, tripKey, newTitle) {
  if (!tripKey || !newTitle) throw new UsageError('Usage: wlog trips rename <tripKey> <newTitle>');
  const current = await getTrip(opts, tripKey);
  const ops = [{ p: ['title'], oi: newTitle, od: current.title }];
  await applyTripOps(opts, tripKey, ops);
  return { tripKey, title: newTitle };
}

export async function setDates(opts = {}, tripKey, startDate, endDate, { alignDaySections = false } = {}) {
  if (!tripKey || !startDate || !endDate) throw new UsageError('Usage: wlog trips set-dates <tripKey> <startDate> <endDate>');
  validateDate(startDate, 'startDate');
  validateDate(endDate, 'endDate');

  const current = await getTrip(opts, tripKey);
  const ops = [
    { p: ['startDate'], oi: startDate, od: current.startDate ?? null },
    { p: ['endDate'], oi: endDate, od: current.endDate ?? null },
  ];
  let expectedDays;
  if (alignDaySections) {
    const dateMs = value => {
      const time = Date.parse(`${value}T00:00:00Z`);
      if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) throw new UsageError('Dates must be valid calendar dates');
      return time;
    };
    const start = dateMs(startDate);
    const end = dateMs(endDate);
    const count = (end - start) / 86400000 + 1;
    if (!Number.isInteger(count) || count < 1 || count > 366) throw new UsageError('Date range must be 1–366 days');
    const raw = unwrapTripPayload(current.raw);
    const sections = raw.itinerary?.sections;
    if (!Array.isArray(sections)) throw new UsageError('Trip sections unavailable');
    const daySections = sections.map((section, index) => ({ section, index })).filter(x => x.section.mode === 'dayPlan');
    if (daySections.length > count) throw new UsageError('Refusing to remove existing day sections');
    if (daySections.some(x => x.section.type !== 'normal' || !Array.isArray(x.section.blocks))) throw new UsageError('Invalid day section');
    const oldStart = current.startDate ? dateMs(current.startDate) : null;
    if (daySections.some((x, i) => x.section.date != null && (!oldStart || x.section.date !== new Date(oldStart + i * 86400000).toISOString().slice(0, 10)))) {
      throw new UsageError('Existing day dates do not align with the original start date');
    }
    const ids = new Set(sections.flatMap(s => [String(s.id), ...(s.blocks || []).map(b => String(b.id))]));
    expectedDays = [];
    const dateFor = i => new Date(start + i * 86400000).toISOString().slice(0, 10);
    for (let i = 0; i < daySections.length; i++) {
      const { section, index } = daySections[i];
      expectedDays.push({ id: String(section.id), date: dateFor(i) });
      if (section.date != null) ops.push({ p: ['itinerary', 'sections', index, 'date'], oi: dateFor(i), od: section.date });
    }
    let insertIndex = daySections.length ? daySections.at(-1).index + 1 : sections.length;
    for (let i = daySections.length; i < count; i++) {
      let id;
      do id = randomInt(100000000, 999999999); while (ids.has(String(id)));
      ids.add(String(id));
      const section = { id, heading: '', mode: 'dayPlan', type: 'normal', blocks: [], date: dateFor(i), text: { ops: [{ insert: '\n' }] }, placeMarkerColor: '#3f52e3', placeMarkerIcon: 'map-marker' };
      expectedDays.push({ id: String(id), date: dateFor(i) });
      ops.push({ p: ['itinerary', 'sections', insertIndex++], li: section });
    }
  }
  await applyTripOps(opts, tripKey, ops);
  if (expectedDays) {
    const after = await getTrip(opts, tripKey);
    const days = unwrapTripPayload(after.raw).itinerary.sections.filter(s => s.mode === 'dayPlan');
    if (after.startDate !== startDate || after.endDate !== endDate || days.length !== expectedDays.length || days.some((s, i) => String(s.id) !== expectedDays[i].id || (s.date != null && s.date !== expectedDays[i].date))) {
      throw new ApiError('Post-write date-section verification failed; inspect the trip before further edits');
    }
  }
  return { ...normalizeTripSummary(current), startDate, endDate };
}

export async function deleteTrip(opts = {}, tripKey, { confirm } = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog trips delete <tripKey> --confirm <tripKey>');
  if (confirm !== tripKey) throw new ConfirmRequiredError(`Deletion requires --confirm ${tripKey}`);
  const client = createClient(opts);
  await client.del(`/api/tripPlans/${encodeURIComponent(tripKey)}`);
  // Wanderlog moves a deleted trip to its Trash; only the web UI deletes it permanently.
  return { deleted: true, trashed: true, tripKey, note: 'Moved to Wanderlog Trash; delete permanently in the web UI (Trash, then Delete permanently)' };
}

export async function searchDestination(opts = {}, query) {
  if (!query) throw new UsageError('Usage: wlog places search <query>');
  const client = createClient(opts);
  const data = await client.get(`/api/geo/autocomplete/${encodeURIComponent(query)}`);
  return unwrapGeoList(data).map(normalizeGeoResult);
}

export async function applyTripOps(opts = {}, tripKey, ops = []) {
  if (!tripKey) throw new UsageError('Missing tripKey');
  const client = createClient(opts);
  const result = await client.post(`/api/tripPlans/${encodeURIComponent(tripKey)}/applyOps`, { ops });
  if (!opts.skipPostValidate) {
    const data = await client.get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
    assertTripPlanValid(data);
  }
  return result;
}

// Server error texts seen when a text0 compare component meets a different
// value, no value or a non-string, and when a list index is past the end.
const GUARD_REFUSAL_RE = /does not match deleted text|out of bounds|Cannot read properties of undefined|is not a function/;

// A text0 component that leaves the string at `path` as it is but makes the
// server refuse the whole batch unless that string starts with `text`. See the
// header of src/budget.mjs for the measured applyOps contract.
export function textCompare(path, text) {
  return { p: path, t: 'text0', o: [{ p: 0, d: text }, { p: 0, i: text }] };
}

// Post one op batch that carries text0 compare components, then re-fetch.
// Nothing is retried. A batch the server refused on a compare (or on an index
// past the end) wrote nothing: ConcurrentChangeError, exit 8. Any failure
// once the write may have been accepted: VerificationError, exit 7.
// `subject` names what is written ("Budget"), `changed` says what moved,
// `inspect` is the command to run before a retry and `read` turns the
// re-fetched trip into the caller's view of it.
export async function applyGuardedOps(opts = {}, tripKey, ops, { label, subject, changed, inspect, read = data => data }) {
  const advice = `not retried. Before retrying run: ${inspect}`;
  let result;
  try {
    result = await applyTripOps({ ...opts, skipPostValidate: true }, tripKey, ops);
  } catch (err) {
    // Missing or refused credentials, a 404 and a 4xx answer are definite
    // rejections. Anything else (network failure, 5xx, a body that cannot be
    // read or parsed) may or may not have been applied.
    const definite = err instanceof AuthRequiredError || err instanceof AuthExpiredError || err instanceof TokenCorruptError
      || err instanceof NotFoundError || err instanceof UsageError
      || (err instanceof ApiError && err.status >= 400 && err.status < 500);
    if (definite) throw err;
    throw new VerificationError(`${subject} write outcome is uncertain for ${label} (${err?.message ?? err}); ${advice}`);
  }
  if (result?.success === false) {
    // A refused batch is refused as a whole.
    if (GUARD_REFUSAL_RE.test(String(result.error ?? ''))) {
      throw new ConcurrentChangeError(`${changed}, so Wanderlog refused the ${label}; nothing was written. Safe to re-run after: ${inspect}`);
    }
    // The server's error text echoes trip data; report only its type.
    throw new ApiError(`Wanderlog rejected the ${label}; nothing was written (${[].concat(result.errTypes ?? 'no error type').join(', ')})`);
  }
  // From here on the write has been accepted: every failure is exit 7.
  try {
    const data = await createClient(opts).get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
    assertTripPlanValid(data);
    return read(data);
  } catch (err) {
    throw new VerificationError(`${subject} write sent for ${label} but it could not be verified (${err?.message ?? err}); ${advice}`);
  }
}

function unwrapTripList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.tripPlans)) return data.tripPlans;
  if (Array.isArray(data?.trips)) return data.trips;
  throw new ApiError('Unexpected Wanderlog trip list response shape');
}

function unwrapTripPayload(data) {
  return data?.tripPlan ?? data?.data?.tripPlan ?? data?.data ?? data;
}

function unwrapGeoList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.places)) return data.places;
  throw new ApiError('Unexpected Wanderlog geo autocomplete response shape');
}

function normalizeGeoResult(raw = {}) {
  const location = raw.geometry?.location ?? raw.location ?? {};
  return {
    id: raw.id ?? raw.geoId ?? raw.place_id ?? null,
    name: raw.name ?? raw.title ?? null,
    formatted_address: raw.formatted_address ?? raw.address ?? raw.description ?? null,
    lat: raw.lat ?? location.lat ?? null,
    lng: raw.lng ?? location.lng ?? null,
    types: raw.types ?? [],
    subcategory: raw.subcategory,
  };
}

function validateOptionalDate(value, label) {
  if (value == null || value === '') return;
  validateDate(value, label);
}

function validateDate(value, label) {
  if (!DATE_RE.test(String(value))) throw new UsageError(`${label} must match YYYY-MM-DD`);
}
