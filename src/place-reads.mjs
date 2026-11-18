// Read-only place lookups through Wanderlog's own Places proxy and directions cache, with the CLI
// session cookie (no Google key, no trip key, nothing written):
//   wlog places resolve --query Q [--near lat,lng] [--radius m] | --place-id ID   ranked candidates
//   wlog places travel --from PLACE_ID --to PLACE_ID                              travel time per mode
//   wlog trips travel <tripKey>                                                   a trip's day legs
// Endpoints and shapes measured in spike S7 (branch trip-sync/spike). Every response is checked
// against that shape; anything else fails closed (exit 1) instead of being guessed at.

import { createClient } from './client.mjs';
import { ApiError, UsageError } from './errors.mjs';
import { tripPlanOf } from './sync.mjs';

const MAX_CANDIDATES = 5;
const DEFAULT_RADIUS = 50000;
// The search endpoint requires a location and radius; "anywhere" is (0, 0) with 20,000 km.
const WORLD = { lat: 0, lng: 0, radius: 20000000 };
const MODE_ORDER = ['driving', 'transit', 'walking'];

const isObject = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const finite = v => typeof v === 'number' && Number.isFinite(v);
const shapeError = (what, detail) => new ApiError(`Wanderlog ${what}: unexpected response shape (${detail}); nothing was guessed`);

export function parseNear(text) {
  const parts = String(text ?? '').split(',').map(s => s.trim());
  const [lat, lng] = parts.map(Number);
  if (parts.length !== 2 || parts.some(p => p === '') || !finite(lat) || !finite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new UsageError('--near must be "lat,lng" in decimal degrees');
  }
  return { lat, lng };
}

function parseRadius(text) {
  if (text == null) return DEFAULT_RADIUS;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1 || n > WORLD.radius) throw new UsageError('--radius must be a whole number of metres');
  return n;
}

// GET /api/placesAPI/searchPlaces rows: {placeId, name, latitude, longitude, address, categories, ...}.
export function parseSearchRows(response) {
  if (!isObject(response) || response.success !== true || !Array.isArray(response.data)) throw shapeError('searchPlaces', 'expected {success: true, data: [...]}');
  return response.data.map((row, i) => {
    if (!isObject(row) || typeof row.placeId !== 'string' || !row.placeId || typeof row.name !== 'string' || !finite(row.latitude) || !finite(row.longitude)) {
      throw shapeError('searchPlaces', `row ${i} lacks placeId, name, latitude or longitude`);
    }
    return { place_id: row.placeId, name: row.name, lat: row.latitude, lng: row.longitude };
  });
}

// GET /api/placesAPI/getPlaceDetails/v2 data: a Google place {place_id, name, geometry, formatted_address, types, ...}.
export function parseDetails(response, placeId) {
  const d = isObject(response) && response.success === true ? response.data : null;
  if (!isObject(d)) throw shapeError('getPlaceDetails', 'expected {success: true, data: {...}}');
  const location = d.geometry?.location;
  if (d.place_id !== placeId) throw shapeError('getPlaceDetails', `asked for ${placeId}, got ${d.place_id ?? 'no place_id'}`);
  if (typeof d.name !== 'string' || !d.name || !finite(location?.lat) || !finite(location?.lng) || typeof d.formatted_address !== 'string'
    || !Array.isArray(d.types) || d.types.some(t => typeof t !== 'string')) {
    throw shapeError('getPlaceDetails', `${placeId} lacks name, geometry.location, formatted_address or types`);
  }
  return { place_id: d.place_id, name: d.name, lat: location.lat, lng: location.lng, address: d.formatted_address, types: [...d.types] };
}

async function details(client, placeId) {
  return parseDetails(await client.get(`/api/placesAPI/getPlaceDetails/v2?placeId=${encodeURIComponent(placeId)}&language=en`), placeId);
}

// Ranked candidates (Wanderlog's search order, up to 5), each with Google details. Never picks one:
// the caller (the owner, through the vault) pins a place_id.
export async function resolvePlace(opts = {}, { query, placeId, near, radius } = {}) {
  if (Boolean(query) === Boolean(placeId)) throw new UsageError('Usage: wlog places resolve (--query <text> [--near lat,lng] [--radius m] | --place-id <id>) --json');
  const client = createClient(opts);
  if (placeId) {
    if (near != null || radius != null) throw new UsageError('--near and --radius apply to --query only');
    return { place_id: placeId, source: 'wanderlog', candidates: [{ rank: 1, ...await details(client, placeId) }] };
  }
  const bias = near != null ? { ...parseNear(near), radius: parseRadius(radius) } : (radius != null ? null : WORLD);
  if (!bias) throw new UsageError('--radius needs --near');
  const request = { type: 'search', query, longitude: bias.lng, latitude: bias.lat, radiusMeters: bias.radius };
  const rows = parseSearchRows(await client.get(`/api/placesAPI/searchPlaces?request=${encodeURIComponent(JSON.stringify(request))}`));
  const candidates = [];
  for (const [i, row] of rows.slice(0, MAX_CANDIDATES).entries()) candidates.push({ rank: i + 1, ...await details(client, row.place_id) });
  return {
    query,
    near: near != null ? { lat: bias.lat, lng: bias.lng, radius: bias.radius } : null,
    source: 'wanderlog',
    candidates,
  };
}

// GET /api/directions/allDistanceInfoForPlace/v2 data: {mode: {route: {duration: {value, text},
// distance: {value}}} | {route: null} | null}. Seconds and metres are Wanderlog's own numbers.
export function parseDistanceInfo(response) {
  if (!isObject(response) || response.success !== true || !isObject(response.data)) throw shapeError('allDistanceInfoForPlace', 'expected {success: true, data: {...}}');
  const out = {};
  for (const mode of Object.keys(response.data).sort()) out[mode] = parseLegValue(response.data[mode], `mode ${mode}`, 'allDistanceInfoForPlace');
  return out;
}

function parseLegValue(value, at, what) {
  if (value == null || (isObject(value) && value.route == null)) return null;
  const route = isObject(value) ? value.route : null;
  if (!isObject(route) || !finite(route.duration?.value) || !finite(route.distance?.value)) throw shapeError(what, `${at} has no route duration/distance values`);
  return { seconds: route.duration.value, meters: route.distance.value, text: typeof route.duration.text === 'string' ? route.duration.text : null };
}

export async function placeTravel(opts = {}, { from, to } = {}) {
  if (!from || !to) throw new UsageError('Usage: wlog places travel --from <place_id> --to <place_id> --json');
  const client = createClient(opts);
  const a = await details(client, from);
  const b = await details(client, to);
  const data = {
    fromPlace: { id: a.place_id, longitude: a.lng, latitude: a.lat },
    toPlace: { id: b.place_id, longitude: b.lng, latitude: b.lat },
    directionsDataSource: 'fetchAllFromAPI',
  };
  const modes = parseDistanceInfo(await client.get(`/api/directions/allDistanceInfoForPlace/v2?data=${encodeURIComponent(JSON.stringify(data))}`));
  const end = p => ({ place_id: p.place_id, name: p.name, lat: p.lat, lng: p.lng });
  return { from: end(a), to: end(b), source: 'wanderlog', modes };
}

// resources.distancesBetweenPlaces: {'["fromPlaceId","toPlaceId","mode"]': {travelMode, route}}.
export function parseDistances(resources) {
  const raw = resources?.distancesBetweenPlaces;
  if (raw == null) return new Map();
  if (!isObject(raw)) throw shapeError('trip resources', 'distancesBetweenPlaces is not an object');
  const out = new Map();
  for (const [key, value] of Object.entries(raw)) {
    let parts;
    try {
      parts = JSON.parse(key);
    } catch {
      parts = null;
    }
    if (!Array.isArray(parts) || parts.length !== 3 || parts.some(p => typeof p !== 'string')) throw shapeError('trip resources', `distancesBetweenPlaces key ${key.slice(0, 80)}`);
    const pair = `${parts[0]}\u0000${parts[1]}`;
    if (!out.has(pair)) out.set(pair, new Map());
    out.get(pair).set(parts[2], parseLegValue(value, `leg ${parts.join(' -> ')}`, 'trip resources'));
  }
  return out;
}

// One leg per pair of consecutive stops on each day, in day order: the lodging the day starts
// from (a hotel card with checkIn < date <= checkOut), the day's place cards with a Google id,
// then the lodging of that night (checkIn <= date < checkOut). A card's travelMode picks the
// leg's mode; without one, the mode Wanderlog computed (driving, transit, walking first).
// seconds is null when Wanderlog has no leg for the pair yet.
export function tripLegs(doc) {
  const plan = tripPlanOf(doc);
  const distances = parseDistances(doc.resources);
  const sections = plan.itinerary.sections;
  const hotels = sections.flatMap(s => (s.blocks || []).filter(b => b.type === 'place' && isObject(b.hotel) && b.place?.place_id)
    .map(b => ({ block: Number(b.id), place_id: b.place.place_id, name: b.place.name ?? '', checkIn: b.hotel.checkIn, checkOut: b.hotel.checkOut, role: 'lodging', travelMode: null })));
  const legs = [];
  for (const s of sections.filter(x => x.mode === 'dayPlan')) {
    const date = s.date;
    const cards = (s.blocks || []).filter(b => b.type === 'place' && b.place?.place_id)
      .map(b => ({ block: Number(b.id), place_id: b.place.place_id, name: b.place.name ?? '', role: 'card', travelMode: b.travelMode ?? null }));
    const morning = typeof date === 'string' ? hotels.find(h => h.checkIn < date && date <= h.checkOut) : null;
    const night = typeof date === 'string' ? hotels.find(h => h.checkIn <= date && date < h.checkOut) : null;
    const stops = [...(morning ? [morning] : []), ...cards, ...(night ? [night] : [])];
    for (let i = 0; i + 1 < stops.length; i += 1) {
      const a = stops[i];
      const b = stops[i + 1];
      if (a.place_id === b.place_id) continue;
      const found = distances.get(`${a.place_id}\u0000${b.place_id}`) || new Map();
      const order = [...MODE_ORDER, ...[...found.keys()].filter(m => !MODE_ORDER.includes(m)).sort()];
      const mode = b.travelMode ?? order.find(m => found.has(m)) ?? null;
      const info = mode ? found.get(mode) ?? null : null;
      legs.push({
        date, section: Number(s.id),
        from: { block: a.block, role: a.role, place_id: a.place_id, name: a.name },
        to: { block: b.block, role: b.role, place_id: b.place_id, name: b.name },
        travelMode: b.travelMode, mode, seconds: info?.seconds ?? null, meters: info?.meters ?? null,
      });
    }
  }
  return legs;
}

export async function tripTravel(opts = {}, tripKey) {
  if (!tripKey) throw new UsageError('Usage: wlog trips travel <tripKey> --json');
  const data = await createClient(opts).get(`/api/tripPlans/${encodeURIComponent(tripKey)}?clientSchemaVersion=2`);
  if (!data?.tripPlan) throw new ApiError(`Fetch returned no trip (${[].concat(data?.errTypes ?? 'no error type').join(', ')})`);
  const legs = tripLegs(data);
  return { tripKey, version: data.tripPlan.overallVersion, legs, missing: legs.filter(l => l.seconds === null).length };
}
