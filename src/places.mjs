import { randomInt } from 'node:crypto';
import { loadToken } from './token-store.mjs';
import { ApiError, ConfirmRequiredError, NotFoundError, UsageError } from './errors.mjs';
import { normalizePlaceBlock } from './models.mjs';
import { addAiPrefix, buildAiTextOps, generateAiHash, preserveAiPrefix } from './ai-attribution.mjs';
import { getTrip, searchDestination, applyTripOps } from './trips.mjs';
import { findSectionIndex, parseIndex, rawSections, sectionPath } from './sections.mjs';

const TIME_RE = /^\d{2}:\d{2}$/;
const GOOGLE_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'shortFormattedAddress',
  'location',
  'types',
  'rating',
  'userRatingCount',
  'websiteUri',
  'googleMapsUri',
  'businessStatus',
  'addressComponents',
  'regularOpeningHours',
  'primaryType',
].join(',');

export async function searchPlace(opts = {}, query) {
  return searchDestination(opts, query);
}

export async function listPlaces(opts = {}, tripKey) {
  if (!tripKey) throw new UsageError('Usage: wlog places list <tripKey>');
  const trip = await getTrip(opts, tripKey);
  return rawSections(trip).flatMap(section => {
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    return blocks.map((block, blockIndex) => ({
      sectionId: section.id ?? null,
      sectionHeading: section.heading ?? null,
      ...normalizePlaceBlock(block, blockIndex),
    }));
  });
}

export async function addPlace(opts = {}, tripKey, sectionId, details = {}) {
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog places add <tripKey> <sectionId> --name --lat --lng --address [--notes --start --end --no-ai]');
  const { name, address, notes, startTime, endTime, ai = true } = details;
  if (!name) throw new UsageError('--name is required');
  if (!address) throw new UsageError('--address is required');
  const lat = parseCoordinate(details.lat, 'lat');
  const lng = parseCoordinate(details.lng, 'lng');
  validateOptionalTime(startTime, 'startTime');
  validateOptionalTime(endTime, 'endTime');

  const token = await loadToken(opts);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const block = buildPlaceBlock({ name, lat, lng, address, notes, startTime, endTime, ai, userId: token?.userId });

  await applyTripOps(opts, tripKey, [{ p: sectionPath(secIdx, 'blocks', blocks.length), li: block }]);
  return { sectionId: String(sectionId), blockIndex: blocks.length, ...normalizePlaceBlock(block, blocks.length) };
}

export async function enrichAddPlace(opts = {}, tripKey, sectionId, details = {}) {
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog places enrich-add <tripKey> <sectionId> --query <query> [--notes --start --end --no-ai --google-key <key>]');
  const { query, notes, startTime, endTime, ai = true } = details;
  if (!query) throw new UsageError('--query is required');
  validateOptionalTime(startTime, 'startTime');
  validateOptionalTime(endTime, 'endTime');

  const token = await loadToken(opts);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const beforeBlocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];

  const placeId = await gSearch(query, { apiKey: details.googleKey || opts.googleKey, fetchImpl: opts.fetch });
  const detailsV1 = await gDetails(placeId, { apiKey: details.googleKey || opts.googleKey, fetchImpl: opts.fetch });
  const legacy = toLegacy(detailsV1);
  const block = buildEnrichedPlaceBlock({ legacy, query, notes, startTime, endTime, ai, userId: token?.userId });
  const blockIndex = beforeBlocks.length;

  await applyTripOps(opts, tripKey, [{ p: ['itinerary', 'sections', secIdx, 'blocks', blockIndex], li: block }]);

  const afterTrip = await getTrip(opts, tripKey);
  const afterSections = rawSections(afterTrip);
  const afterSecIdx = findSectionIndex(afterSections, sectionId);
  const afterBlocks = Array.isArray(afterSections[afterSecIdx].blocks) ? afterSections[afterSecIdx].blocks : [];
  if (afterBlocks.length !== beforeBlocks.length + 1) {
    throw new ApiError(`Post-insert verification failed: expected section block count ${beforeBlocks.length + 1}, got ${afterBlocks.length}`);
  }

  return {
    tripKey,
    sectionId: String(sectionId),
    blockIndex,
    beforeBlockCount: beforeBlocks.length,
    afterBlockCount: afterBlocks.length,
    googlePlaceId: legacy.place_id,
    ...normalizePlaceBlock(block, blockIndex),
  };
}

export async function updatePlace(opts = {}, tripKey, sectionId, blockIndex, updates = {}) {
  if (!tripKey || !sectionId || blockIndex == null) throw new UsageError('Usage: wlog places update <tripKey> <sectionId> <blockIndex> [--name --address --notes --start --end --lat --lng]');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const idx = parseIndex(blockIndex, 0, blocks.length - 1, 'blockIndex');
  const block = blocks[idx];
  if (!block || block.type !== 'place') throw new NotFoundError(`Place block not found at index: ${blockIndex}`);

  const ops = [];
  addNameOp(ops, secIdx, idx, block, updates);
  addSimplePlaceOp(ops, secIdx, idx, block, updates, 'address', ['place', 'formatted_address']);
  addNotesOp(ops, secIdx, idx, block, updates);
  addTimeOp(ops, secIdx, idx, block, updates, 'startTime');
  addTimeOp(ops, secIdx, idx, block, updates, 'endTime');
  addCoordinateOp(ops, secIdx, idx, block, updates, 'lat');
  addCoordinateOp(ops, secIdx, idx, block, updates, 'lng');

  if (ops.length > 0) await applyTripOps(opts, tripKey, ops);
  return { sectionId: String(sectionId), blockIndex: idx, changed: ops.length };
}

export async function deletePlace(opts = {}, tripKey, sectionId, blockIndex, { confirm } = {}) {
  if (!tripKey || !sectionId || blockIndex == null) throw new UsageError('Usage: wlog places delete <tripKey> <sectionId> <blockIndex> --confirm <blockIndex>');
  if (confirm !== String(blockIndex)) throw new ConfirmRequiredError(`Deletion requires --confirm ${blockIndex}`);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const secIdx = findSectionIndex(sections, sectionId);
  const blocks = Array.isArray(sections[secIdx].blocks) ? sections[secIdx].blocks : [];
  const idx = parseIndex(blockIndex, 0, blocks.length - 1, 'blockIndex');
  await applyTripOps(opts, tripKey, [{ p: sectionPath(secIdx, 'blocks', idx), ld: blocks[idx] }]);
  return { deleted: true, sectionId: String(sectionId), blockIndex: idx };
}

export async function movePlace(opts = {}, tripKey, fromSectionId, blockIndex, toSectionId, toIndex) {
  if (!tripKey || !fromSectionId || blockIndex == null || !toSectionId) throw new UsageError('Usage: wlog places move <tripKey> <fromSectionId> <blockIndex> <toSectionId> [--to-index <n>]');
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const fromSecIdx = findSectionIndex(sections, fromSectionId);
  const toSecIdx = findSectionIndex(sections, toSectionId);
  const fromBlocks = Array.isArray(sections[fromSecIdx].blocks) ? sections[fromSecIdx].blocks : [];
  const toBlocks = Array.isArray(sections[toSecIdx].blocks) ? sections[toSecIdx].blocks : [];
  const fromIdx = parseIndex(blockIndex, 0, fromBlocks.length - 1, 'blockIndex');
  const insertionMax = fromSecIdx === toSecIdx ? Math.max(0, toBlocks.length - 1) : toBlocks.length;
  const targetIdx = toIndex == null ? insertionMax : parseIndex(toIndex, 0, insertionMax, 'toIndex');
  const block = fromBlocks[fromIdx];
  const ops = fromSecIdx === toSecIdx && fromIdx === targetIdx ? [] : [
    { p: sectionPath(fromSecIdx, 'blocks', fromIdx), ld: block },
    { p: sectionPath(toSecIdx, 'blocks', targetIdx), li: block },
  ];
  if (ops.length > 0) await applyTripOps(opts, tripKey, ops);
  return { fromSectionId: String(fromSectionId), toSectionId: String(toSectionId), fromIndex: fromIdx, toIndex: targetIdx };
}

function buildPlaceBlock({ name, lat, lng, address, notes, startTime, endTime, ai, userId }) {
  const hash = generateAiHash();
  return {
    id: randomInt(100000000, 999999999),
    type: 'place',
    place: {
      name: ai ? addAiPrefix(name, hash) : name,
      place_id: null,
      geometry: { location: { lat, lng } },
      formatted_address: address,
      types: ['point_of_interest'],
    },
    text: { ops: ai ? buildAiTextOps(hash, notes) : [{ insert: `${notes || ''}\n` }] },
    addedBy: { type: 'user', userId },
    imageSize: 'small',
    upvotedBy: [],
    travelMode: null,
    attachments: [],
    startTime: startTime || null,
    endTime: endTime || null,
  };
}

function buildEnrichedPlaceBlock({ legacy, query, notes, startTime, endTime, ai, userId }) {
  const hash = generateAiHash(query);
  return {
    id: randomInt(100000000, 999999999),
    type: 'place',
    place: {
      ...legacy,
      name: ai ? addAiPrefix(legacy.name, hash) : legacy.name,
    },
    text: { ops: ai ? buildAiTextOps(hash, notes) : [{ insert: `${notes || ''}\n` }] },
    addedBy: { type: 'user', userId },
    imageSize: 'small',
    upvotedBy: [],
    travelMode: null,
    attachments: [],
    startTime: startTime || null,
    endTime: endTime || null,
  };
}

export async function gSearch(query, { apiKey = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new UsageError('Google Places API key required: set GOOGLE_MAPS_API_KEY or pass --google-key <key>');
  const response = await fetchImpl('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.id,places.displayName',
    },
    body: JSON.stringify({ textQuery: query, languageCode: 'en' }),
  });
  const data = await response.json();
  if (!response.ok || !data.places?.length) {
    throw new ApiError(`No Google Places result for "${query}": ${JSON.stringify(data).slice(0, 500)}`, response.status);
  }
  return data.places[0].id;
}

export async function gDetails(placeId, { apiKey = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new UsageError('Google Places API key required: set GOOGLE_MAPS_API_KEY or pass --google-key <key>');
  const response = await fetchImpl(`https://places.googleapis.com/v1/places/${placeId}?languageCode=en`, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': GOOGLE_FIELDS,
    },
  });
  const data = await response.json();
  if (!response.ok || !data.id) {
    throw new ApiError(`Google Places details failed for ${placeId}: ${JSON.stringify(data).slice(0, 500)}`, response.status);
  }
  return data;
}

export function toLegacy(v1 = {}) {
  return {
    name: v1.displayName?.text || '',
    place_id: v1.id,
    geometry: { location: { lat: v1.location?.latitude, lng: v1.location?.longitude } },
    formatted_address: v1.formattedAddress || '',
    vicinity: v1.shortFormattedAddress || v1.formattedAddress || '',
    rating: v1.rating ?? null,
    user_ratings_total: v1.userRatingCount ?? null,
    website: v1.websiteUri ?? null,
    address_components: (v1.addressComponents || []).map(component => ({
      long_name: component.longText,
      short_name: component.shortText,
      types: component.types,
    })),
    opening_hours: v1.regularOpeningHours
      ? { periods: v1.regularOpeningHours.periods || [], weekday_text: v1.regularOpeningHours.weekdayDescriptions || [] }
      : null,
    types: v1.types || [],
    url: v1.googleMapsUri ?? null,
    business_status: v1.businessStatus ?? null,
    photo_urls: [],
  };
}

function addNameOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.name == null) return;
  const oldName = block.place?.name ?? '';
  const nextName = preserveAiPrefix(oldName, updates.name);
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, 'place', 'name'), nextName, oldName);
}

function addSimplePlaceOp(ops, secIdx, blockIdx, block, updates, key, pathTail) {
  if (updates[key] == null) return;
  const oldValue = block.place?.formatted_address ?? null;
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, ...pathTail), updates[key], oldValue);
}

function addNotesOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.notes == null) return;
  const oldText = block.text ?? { ops: [{ insert: '\n' }] };
  const newText = { ops: [{ insert: `${updates.notes || ''}\n` }] };
  if (JSON.stringify(oldText) !== JSON.stringify(newText)) {
    ops.push({ p: sectionPath(secIdx, 'blocks', blockIdx, 'text'), oi: newText, od: oldText });
  }
}

function addTimeOp(ops, secIdx, blockIdx, block, updates, key) {
  if (updates[key] == null) return;
  validateOptionalTime(updates[key], key);
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, key), updates[key] || null, block[key] ?? null);
}

function addCoordinateOp(ops, secIdx, blockIdx, block, updates, key) {
  if (updates[key] == null) return;
  const value = parseCoordinate(updates[key], key);
  const oldValue = block.place?.geometry?.location?.[key] ?? null;
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, 'place', 'geometry', 'location', key), value, oldValue);
}

function addReplaceOp(ops, path, oi, od) {
  if (oi !== od) ops.push({ p: path, oi, od });
}

function parseCoordinate(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new UsageError(`${label} must be numeric`);
  return number;
}

function validateOptionalTime(value, label) {
  if (value == null || value === '') return;
  if (!TIME_RE.test(String(value))) throw new UsageError(`${label} must match HH:MM`);
}
