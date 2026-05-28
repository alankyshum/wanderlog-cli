import { createClient } from './client.mjs';
import { loadToken } from './token-store.mjs';
import { normalizeTrip, normalizeTripSummary } from './models.mjs';
import { AuthRequiredError, ApiError, ConfirmRequiredError, NotFoundError, UsageError } from './errors.mjs';

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
  const data = await client.post('/api/tripPlans', {
    geoIds: [geoId],
    type: 'tripPlan',
    startDate: startDate || null,
    endDate: endDate || null,
    privacy: 'private',
  });
  return normalizeTripSummary(unwrapTripPayload(data));
}

export async function renameTrip(opts = {}, tripKey, newTitle) {
  if (!tripKey || !newTitle) throw new UsageError('Usage: wlog trips rename <tripKey> <newTitle>');
  const current = await getTrip(opts, tripKey);
  const ops = [{ p: ['title'], oi: newTitle, od: current.title }];
  await applyTripOps(opts, tripKey, ops);
  return { tripKey, title: newTitle };
}

export async function setDates(opts = {}, tripKey, startDate, endDate) {
  if (!tripKey || !startDate || !endDate) throw new UsageError('Usage: wlog trips set-dates <tripKey> <startDate> <endDate>');
  validateDate(startDate, 'startDate');
  validateDate(endDate, 'endDate');

  const current = await getTrip(opts, tripKey);
  const ops = [
    { p: ['startDate'], oi: startDate, od: current.startDate ?? null },
    { p: ['endDate'], oi: endDate, od: current.endDate ?? null },
  ];
  await applyTripOps(opts, tripKey, ops);
  return { ...normalizeTripSummary(current), startDate, endDate };
}

export async function deleteTrip(opts = {}, tripKey, { confirm } = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog trips delete <tripKey> --confirm <tripKey>');
  if (confirm !== tripKey) throw new ConfirmRequiredError(`Deletion requires --confirm ${tripKey}`);
  const client = createClient(opts);
  await client.del(`/api/tripPlans/${encodeURIComponent(tripKey)}`);
  return { deleted: true, tripKey };
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
  return client.post(`/api/tripPlans/${encodeURIComponent(tripKey)}/applyOps`, { ops });
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
