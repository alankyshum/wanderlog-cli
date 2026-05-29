import { randomInt } from 'node:crypto';
import { loadToken } from './token-store.mjs';
import { ApiError, ConfirmRequiredError, NotFoundError, UsageError } from './errors.mjs';
import { normalizePlaceBlock } from './models.mjs';
import { addAiPrefix, preserveAiPrefix } from './ai-attribution.mjs';
import { getTrip, searchDestination, applyTripOps } from './trips.mjs';
import { findSectionIndex, parseIndex, rawSections, sectionPath } from './sections.mjs';

const TIME_RE = /^\d{2}:\d{2}$/;
const GOOGLE_FIELDS = [
  'id',
  'displayName',
  'location',
  'formattedAddress',
  'shortFormattedAddress',
  'types',
  'primaryType',
  'rating',
  'userRatingCount',
  'websiteUri',
  'googleMapsUri',
  'businessStatus',
  'addressComponents',
  'regularOpeningHours',
  'internationalPhoneNumber',
  'nationalPhoneNumber',
  'reviews',
  'plusCode',
  'utcOffsetMinutes',
  'adrFormatAddress',
  'iconMaskBaseUri',
].join(',');
const GOOGLE_STATUS_FIELDS = [
  'id',
  'displayName',
  'businessStatus',
  'googleMapsUri',
].join(',');
const CHECK_STATUS_CONCURRENCY = 10;
const SURFACED_CHECK_STATUSES = new Set([
  'CLOSED_TEMPORARILY',
  'CLOSED_PERMANENTLY',
  'PLACE_ID_INVALID',
]);
const GENERIC_PLACE_TYPES = new Set(['point_of_interest', 'establishment']);
const HUMAN_PLACE_TYPES = new Map([
  ['lodging', 'guesthouse / hotel'],
  ['hotel', 'guesthouse / hotel'],
  ['cafe', 'café'],
  ['restaurant', 'restaurant'],
  ['tourist_attraction', 'tourist attraction'],
  ['park', 'park'],
  ['museum', 'museum'],
  ['store', 'shop'],
  ['clothing_store', 'shop'],
  ['cosmetics_store', 'shop'],
  ['bakery', 'bakery'],
  ['dessert_shop', 'dessert shop'],
  ['ice_cream_shop', 'dessert shop'],
  ['gas_station', 'gas station'],
  ['airport', 'airport'],
  ['parking', 'parking'],
  ['point_of_interest', 'attraction'],
  ['establishment', 'place'],
]);

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
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog places enrich-add <tripKey> <sectionId> --query <query> [--duration <text> --notes --start --end --no-ai --google-key <key>]');
  const { query, notes, duration, startTime, endTime, ai = true } = details;
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
  const photoUrls = details.withPhotos
    ? await gPhotoMediaUrls(detailsV1.photos, { apiKey: details.googleKey || opts.googleKey, fetchImpl: opts.fetch })
    : [];
  const legacy = toLegacy(detailsV1, { photoUrls });
  const preamble = formatNotesPreamble({
    duration,
    name: detailsV1.displayName?.text || legacy.name,
    englishName: englishNameFromPlace(detailsV1),
    primaryType: detailsV1.primaryType || detailsV1.types?.[0],
    types: detailsV1.types,
    languageCode: detailsV1.displayName?.languageCode,
    nameForAttribution: detailsV1.nameForAttribution,
    shortFormattedAddress: detailsV1.shortFormattedAddress,
    internationalPhoneNumber: detailsV1.internationalPhoneNumber,
  });
  const fullNotes = [preamble, notes].filter(Boolean).join('');
  const block = buildEnrichedPlaceBlock({ legacy, query, notes: fullNotes, startTime, endTime, ai, userId: token?.userId });
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

export async function checkPlaceStatuses(opts = {}, tripKey, details = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog places check-status <tripKey> [--json] [--show-unknown] [--google-key <key>]');
  const apiKey = resolveGoogleKey(details.googleKey || opts.googleKey, 'Set --google-key or $GOOGLE_MAPS_API_KEY');
  const showUnknown = Boolean(details.showUnknown ?? opts.showUnknown);
  const trip = await getTrip(opts, tripKey);
  const entries = collectPlaceStatusEntries(trip);
  const statuses = await fetchPlaceStatuses(entries.map(entry => entry.place_id), {
    apiKey,
    fetchImpl: opts.fetch,
  });

  const allRows = entries.map(entry => buildCheckStatusRow(entry, statuses.get(entry.place_id)));
  return {
    summary: buildCheckStatusSummary(allRows),
    rows: filterCheckStatusRows(allRows, { showUnknown }),
  };
}

export function collectPlaceStatusEntries(trip = {}) {
  const normalizedSections = rawSections(trip);
  const sections = normalizedSections.length > 0 ? normalizedSections : rawSections({ raw: trip });
  const entries = [];
  sections.forEach((section, sectionIndex) => {
    const sectionLabel = section.heading ?? section.title ?? section.name ?? section.id ?? `section[${sectionIndex}]`;
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    blocks.forEach((block, blockIndex) => {
      const blockType = block?.type || 'block';
      if (block?.place?.place_id) {
        const role = blockType === 'place' ? `places[${blockIndex}]` : `${blockRole(block, blockIndex)}.place`;
        addStatusEntry(entries, sectionLabel, role, block, block.place);
      }
      addStatusEntry(entries, sectionLabel, `${blockRole(block, blockIndex)}.depart`, block, block?.depart?.airport?.googlePlace);
      addStatusEntry(entries, sectionLabel, `${blockRole(block, blockIndex)}.arrive`, block, block?.arrive?.airport?.googlePlace);
      addStatusEntry(entries, sectionLabel, `${blockRole(block, blockIndex)}.pickUp.place`, block, block?.pickUp?.place);
      addStatusEntry(entries, sectionLabel, `${blockRole(block, blockIndex)}.dropOff.place`, block, block?.dropOff?.place);
    });
  });
  return entries;
}

export function formatCheckStatusReport(result = {}) {
  const rows = Array.isArray(result) ? result : result.rows || [];
  const summary = Array.isArray(result) ? buildCheckStatusSummary(rows) : result.summary || buildCheckStatusSummary(rows);
  const showUnknown = rows.some(row => row.status === 'UNKNOWN');
  return `${formatStatusTable(rows)}\n${formatCheckStatusSummary(summary, { showUnknown })}`;
}

export function formatCheckStatusSummary(summaryOrRows = [], { showUnknown = false } = {}) {
  const summary = Array.isArray(summaryOrRows) ? buildCheckStatusSummary(summaryOrRows) : summaryOrRows;
  const byStatus = summary.byStatus || {};
  const parts = orderedSummaryStatuses(byStatus, { showUnknown })
    .map(status => `${byStatus[status]} ${status.toLowerCase()}`);
  const base = `${summary.total || 0} places checked: ${parts.length > 0 ? parts.join(', ') : 'no places with Google status'}`;
  const unknownCount = byStatus.UNKNOWN || 0;
  if (!showUnknown && unknownCount > 0) {
    return `${base} (run with --show-unknown to also see ${unknownCount} places without business profile)`;
  }
  return base;
}

export function formatNotesPreamble({
  duration,
  name,
  englishName,
  primaryType,
  types = [],
  languageCode,
  nameForAttribution,
  shortFormattedAddress,
  internationalPhoneNumber,
} = {}) {
  const lines = [];
  const trimmedDuration = String(duration || '').trim();
  if (trimmedDuration) lines.push(`**Plan ~${trimmedDuration}.** `);

  const whatName = formatWhatName({
    name,
    englishName,
    languageCode,
    nameForAttribution,
    shortFormattedAddress,
    internationalPhoneNumber,
  });
  const type = humanPlaceType(primaryType, types);
  const todo = whatName.needsEnglishTodo ? ' <!-- TODO: add English name -->' : '';
  lines.push(`**What:** ${whatName.text} — ${type}.${todo}`);
  return `${lines.join('\n')}\n`;
}

export function buildCheckStatusSummary(rows = []) {
  const byStatus = {};
  for (const row of rows) {
    const status = row.status || row.businessStatus || 'UNKNOWN';
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { total: rows.length, byStatus };
}

export function filterCheckStatusRows(rows = [], { showUnknown = false } = {}) {
  return rows.filter(row => shouldSurfaceCheckStatus(row.status, { showUnknown }));
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
  return {
    id: randomInt(100000000, 999999999),
    type: 'place',
    place: {
      name: ai ? addAiPrefix(name) : name,
      place_id: null,
      geometry: { location: { lat, lng } },
      formatted_address: address,
      types: ['point_of_interest'],
    },
    text: { ops: buildTextOps(notes) },
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
  void query;
  return {
    id: randomInt(100000000, 999999999),
    type: 'place',
    place: {
      ...legacy,
      name: ai ? addAiPrefix(legacy.name) : legacy.name,
    },
    text: { ops: buildTextOps(notes) },
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

export async function gStatusDetails(placeId, { apiKey = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new UsageError('Set --google-key or $GOOGLE_MAPS_API_KEY');
  const url = new URL(`https://places.googleapis.com/v1/places/${placeId}`);
  url.searchParams.set('fields', GOOGLE_STATUS_FIELDS);
  url.searchParams.set('languageCode', 'en');
  const response = await fetchImpl(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
    },
  });
  const data = await parseResponseJson(response);
  if (!response.ok || !data.id) {
    const error = new ApiError(`Google Places status details failed for ${placeId}: ${JSON.stringify(data).slice(0, 500)}`, response.status);
    error.data = data;
    throw error;
  }
  return data;
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

export async function gPhotoMediaUrls(photos = [], { apiKey = process.env.GOOGLE_MAPS_API_KEY, fetchImpl = globalThis.fetch } = {}) {
  if (!apiKey) throw new UsageError('Google Places API key required: set GOOGLE_MAPS_API_KEY or pass --google-key <key>');
  const names = photos
    .map(photo => photo?.name)
    .filter(Boolean)
    .slice(0, 3);
  const urls = [];
  for (const name of names) {
    const mediaUrl = new URL(`https://places.googleapis.com/v1/${name}/media`);
    mediaUrl.searchParams.set('maxWidthPx', '1600');
    mediaUrl.searchParams.set('skipHttpRedirect', 'true');
    mediaUrl.searchParams.set('key', apiKey);
    const response = await fetchImpl(mediaUrl);
    const data = await response.json();
    if (!response.ok || !data.photoUri) {
      throw new ApiError(`Google Places photo media failed for ${name}: ${JSON.stringify(data).slice(0, 500)}`, response.status);
    }
    urls.push(data.photoUri);
  }
  return urls;
}

export function toLegacy(v1 = {}, { photoUrls = [] } = {}) {
  const legacy = {
    name: v1.displayName?.text || '',
    place_id: v1.id,
    geometry: { location: { lat: v1.location?.latitude, lng: v1.location?.longitude } },
    formatted_address: v1.formattedAddress || '',
    types: v1.types || [],
  };
  addIfDefined(legacy, 'vicinity', v1.shortFormattedAddress);
  addIfDefined(legacy, 'rating', v1.rating);
  addIfDefined(legacy, 'user_ratings_total', v1.userRatingCount);
  addIfDefined(legacy, 'website', v1.websiteUri);
  addIfDefined(legacy, 'url', v1.googleMapsUri);
  addIfDefined(legacy, 'business_status', v1.businessStatus);
  addIfDefined(legacy, 'international_phone_number', v1.internationalPhoneNumber);
  addIfDefined(legacy, 'formatted_phone_number', v1.nationalPhoneNumber);
  addIfDefined(legacy, 'adr_address', v1.adrFormatAddress);
  addIfDefined(legacy, 'utc_offset', v1.utcOffsetMinutes);
  if (v1.iconMaskBaseUri) legacy.icon = `${v1.iconMaskBaseUri}.png`;
  if (Array.isArray(v1.addressComponents)) {
    legacy.address_components = v1.addressComponents.map(component => ({
      long_name: component.longText,
      short_name: component.shortText,
      types: component.types || [],
    }));
  }
  if (v1.plusCode) {
    legacy.plus_code = {};
    addIfDefined(legacy.plus_code, 'global_code', v1.plusCode.globalCode);
    addIfDefined(legacy.plus_code, 'compound_code', v1.plusCode.compoundCode);
  }
  const reviews = toLegacyReviews(v1.reviews);
  if (reviews) legacy.reviews = reviews;
  const openingHours = toLegacyOpeningHours(v1.regularOpeningHours);
  if (openingHours) legacy.opening_hours = openingHours;
  if (photoUrls.length > 0) legacy.photo_urls = photoUrls;
  return legacy;
}

export function toLegacyOpeningHours(v1OH) {
  if (!v1OH) return undefined;
  const periods = Array.isArray(v1OH.periods) ? v1OH.periods : [];
  if (periods.length === 0) return undefined;
  const isAlways = periods.length === 1
    && periods[0].open?.day === 0
    && periods[0].open?.hour === 0
    && periods[0].open?.minute === 0
    && !periods[0].close;
  const legacyPeriods = isAlways
    ? [0, 1, 2, 3, 4, 5, 6].map(day => ({ open: { day, time: '0000' } }))
    : periods.map(period => {
      const out = { open: { day: period.open.day, time: formatGoogleTime(period.open) } };
      if (period.close) out.close = { day: period.close.day, time: formatGoogleTime(period.close) };
      return out;
    });
  return {
    periods: legacyPeriods,
    weekday_text: v1OH.weekdayDescriptions || [],
  };
}

function toLegacyReviews(reviews) {
  if (!Array.isArray(reviews)) return undefined;
  return reviews.map(review => dropUndefined({
    author_name: review.authorAttribution?.displayName,
    author_url: review.authorAttribution?.uri,
    profile_photo_url: review.authorAttribution?.photoUri,
    rating: review.rating,
    relative_time_description: review.relativePublishTimeDescription,
    text: review.text?.text || review.originalText?.text || '',
    time: review.publishTime ? Math.floor(new Date(review.publishTime).getTime() / 1000) : undefined,
    language: review.text?.languageCode,
  }));
}

function formatGoogleTime(time = {}) {
  const pad = value => String(value ?? 0).padStart(2, '0');
  return `${pad(time.hour)}${pad(time.minute)}`;
}

function addIfDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

function dropUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function resolveGoogleKey(apiKey, missingMessage) {
  const resolved = apiKey || process.env.GOOGLE_MAPS_API_KEY;
  if (!resolved) throw new UsageError(missingMessage);
  return resolved;
}

function addStatusEntry(entries, sectionLabel, role, block, place) {
  const placeId = place?.place_id;
  if (!placeId) return;
  entries.push({
    section: `${sectionLabel}/${role}`,
    'block.id': block?.id ?? null,
    name: place.name ?? place.displayName?.text ?? null,
    place_id: placeId,
    url: place.url ?? place.googleMapsUri ?? null,
  });
}

function blockRole(block, blockIndex) {
  const flightLabel = block?.flightNumber || block?.flightNo || block?.flight?.flightNumber || block?.flight?.number;
  if (flightLabel) return String(flightLabel);
  if (block?.type === 'hotel') return 'lodging';
  if (block?.type === 'rentalCar') return `rentalCar[${blockIndex}]`;
  return `${block?.type || 'block'}[${blockIndex}]`;
}

async function fetchPlaceStatuses(placeIds, opts) {
  const uniquePlaceIds = [...new Set(placeIds.filter(Boolean))];
  const details = new Map();
  for (let start = 0; start < uniquePlaceIds.length; start += CHECK_STATUS_CONCURRENCY) {
    const chunk = uniquePlaceIds.slice(start, start + CHECK_STATUS_CONCURRENCY);
    const results = await Promise.all(chunk.map(placeId => fetchSinglePlaceStatus(placeId, opts)));
    results.forEach((result, index) => details.set(chunk[index], result));
  }
  return details;
}

function formatStatusTable(rows) {
  const keys = ['section', 'block.id', 'name', 'place_id', 'status', 'currentName', 'businessStatus', 'url'];
  const render = row => keys.map(key => String(row[key] ?? '')).join(' | ');
  const header = keys.join(' | ');
  const separator = keys.map(() => '---').join(' | ');
  return [header, separator, ...rows.map(render)].join('\n');
}

async function fetchSinglePlaceStatus(placeId, opts) {
  try {
    const detailsV1 = await gStatusDetails(placeId, opts);
    const businessStatus = detailsV1.businessStatus || null;
    return {
      status: businessStatus || 'UNKNOWN',
      businessStatus,
      currentName: detailsV1.displayName?.text || null,
      url: detailsV1.googleMapsUri || null,
    };
  } catch (error) {
    if (error?.status === 404 || error?.data?.error?.status === 'NOT_FOUND') {
      return { status: 'PLACE_ID_INVALID', businessStatus: null, currentName: null, url: null };
    }
    if (Number.isInteger(error?.status) && error.status > 0) {
      return { status: `ERR_${error.status}`, businessStatus: null, currentName: null, url: null };
    }
    return { status: 'ERR_FETCH', businessStatus: null, currentName: null, url: null };
  }
}

function buildCheckStatusRow(entry, status = {}) {
  return {
    section: entry.section,
    'block.id': entry['block.id'],
    name: entry.name || status.currentName || null,
    place_id: entry.place_id,
    businessStatus: status.businessStatus || null,
    status: status.status || 'ERR_FETCH',
    currentName: status.currentName || null,
    url: status.url || entry.url || null,
  };
}

function shouldSurfaceCheckStatus(status, { showUnknown = false } = {}) {
  if (status === 'OPERATIONAL') return false;
  if (status === 'UNKNOWN') return showUnknown;
  return SURFACED_CHECK_STATUSES.has(status) || String(status || '').startsWith('ERR_');
}

function orderedSummaryStatuses(byStatus = {}, { showUnknown = false } = {}) {
  const preferred = [
    'OPERATIONAL',
    'CLOSED_TEMPORARILY',
    'CLOSED_PERMANENTLY',
    'PLACE_ID_INVALID',
    ...(showUnknown ? ['UNKNOWN'] : []),
  ];
  const preferredSet = new Set(preferred);
  return [
    ...preferred.filter(status => byStatus[status] > 0),
    ...Object.keys(byStatus)
      .filter(status => byStatus[status] > 0 && !preferredSet.has(status) && status !== 'UNKNOWN')
      .sort(),
  ];
}

async function parseResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function addNameOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.name == null) return;
  const oldName = block.place?.name ?? '';
  const nextName = preserveAiPrefix(oldName, updates.name);
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, 'place', 'name'), nextName, oldName);
}

function buildTextOps(userNotes = '') {
  const text = String(userNotes || '');
  return [{ insert: text.endsWith('\n') ? text : `${text}\n` }];
}

function addSimplePlaceOp(ops, secIdx, blockIdx, block, updates, key, pathTail) {
  if (updates[key] == null) return;
  const oldValue = block.place?.formatted_address ?? null;
  addReplaceOp(ops, sectionPath(secIdx, 'blocks', blockIdx, ...pathTail), updates[key], oldValue);
}

function addNotesOp(ops, secIdx, blockIdx, block, updates) {
  if (updates.notes == null) return;
  const oldText = block.text ?? { ops: [{ insert: '\n' }] };
  const newText = { ops: buildTextOps(updates.notes) };
  if (JSON.stringify(oldText) !== JSON.stringify(newText)) {
    ops.push({ p: sectionPath(secIdx, 'blocks', blockIdx, 'text'), oi: newText, od: oldText });
  }
}

function formatWhatName({ name, englishName, languageCode, nameForAttribution, shortFormattedAddress, internationalPhoneNumber }) {
  void languageCode;
  void shortFormattedAddress;
  void internationalPhoneNumber;
  const original = String(name || '').trim() || 'Unknown place';
  if (isLatinOrChineseName(original)) return { text: original, needsEnglishTodo: false };

  const fallback = pickEnglishName({ original, englishName, nameForAttribution });
  if (fallback) return { text: `${original} (${fallback})`, needsEnglishTodo: false };
  return { text: original, needsEnglishTodo: true };
}

function englishNameFromPlace(place = {}) {
  return place.englishName
    || place.editorialSummary?.text
    || place.generativeSummary?.overview?.text
    || place.evChargeOptions?.connectorAggregation?.displayName?.text
    || '';
}

function pickEnglishName({ original, englishName, nameForAttribution }) {
  const candidates = [
    englishName,
    typeof nameForAttribution === 'string' ? nameForAttribution : nameForAttribution?.text,
  ];
  for (const candidate of candidates) {
    const text = String(candidate || '').trim();
    if (text && text !== original && isLikelyEnglishLabel(text)) return text;
  }
  return '';
}

function isLatinOrChineseName(value) {
  const letters = Array.from(String(value || '')).filter(char => /\p{Letter}/u.test(char));
  if (letters.length === 0) return true;
  return letters.every(char => /\p{Script=Latin}|\p{Script=Han}/u.test(char));
}

function isLikelyEnglishLabel(value) {
  const letters = Array.from(String(value || '')).filter(char => /\p{Letter}/u.test(char));
  return letters.some(char => /\p{Script=Latin}/u.test(char))
    && letters.every(char => /\p{Script=Latin}/u.test(char));
}

function humanPlaceType(primaryType, types = []) {
  const typeList = Array.isArray(types) ? types : [];
  const chosenType = choosePlaceType(primaryType, typeList);
  return HUMAN_PLACE_TYPES.get(chosenType) || humanizeType(chosenType);
}

function choosePlaceType(primaryType, types = []) {
  if (primaryType && !GENERIC_PLACE_TYPES.has(primaryType)) return primaryType;
  const secondary = types.find(type => type && type !== primaryType && !GENERIC_PLACE_TYPES.has(type));
  if (secondary) return secondary;
  return primaryType || types.find(Boolean) || 'point_of_interest';
}

function humanizeType(type = 'point_of_interest') {
  return String(type || 'point_of_interest').replace(/_/g, ' ');
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
