import { randomInt } from 'node:crypto';
import { loadToken } from './token-store.mjs';
import { ConfirmRequiredError, UsageError } from './errors.mjs';
import { addPlace, enrichAddPlace, gDetails, gSearch, toLegacy } from './places.mjs';
import { debugFetch, getTrip, applyTripOps } from './trips.mjs';
import { findSectionIndex, parseIndex, rawSections, sectionPath } from './sections.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HOTEL_PLACE_KEYS = [
  'name',
  'place_id',
  'geometry',
  'formatted_address',
  'types',
  'vicinity',
  'rating',
  'user_ratings_total',
  'url',
  'business_status',
  'international_phone_number',
  'formatted_phone_number',
  'adr_address',
  'utc_offset',
  'icon',
  'address_components',
  'plus_code',
  'reviews',
];

export async function addLodging(opts = {}, tripKey, details = {}) {
  if (!tripKey) throw new UsageError('Usage: wlog lodging add <tripKey> --query <hotel> --check-in YYYY-MM-DD --check-out YYYY-MM-DD');
  validateDate(details.checkIn, '--check-in');
  validateDate(details.checkOut, '--check-out');
  if (details.checkIn > details.checkOut) throw new UsageError('--check-in must be on or before --check-out');
  if (!details.query) throw new UsageError('--query is required');

  const token = await loadToken(opts);
  const trip = await getTrip(opts, tripKey);
  const sections = rawSections(trip);
  const ids = collectExistingIds(sections);
  const userId = String(token?.userId ?? trip.raw?.tripPlan?.userId ?? trip.raw?.data?.tripPlan?.userId ?? '');
  const block = await buildHotelBlock({
    ids,
    details,
    ai: details.ai !== false,
    userId,
    googleKey: details.googleKey || opts.googleKey,
    fetchImpl: opts.fetch,
  });

  const target = resolveHotelsTarget(sections, details, ids);
  const ops = target.newSection
    ? [{ p: sectionPath(target.sectionIndex), li: { ...target.newSection, blocks: [block] } }]
    : [{ p: sectionPath(target.sectionIndex, 'blocks', target.blockIndex), li: block }];

  await applyTripOps(opts, tripKey, ops);

  const after = await getTrip(opts, tripKey);
  const afterSections = rawSections(after);
  const afterSection = target.newSection
    ? afterSections.find(section => String(section.id) === String(target.newSection.id))
    : afterSections[target.sectionIndex];
  const afterBlock = afterSection?.blocks?.find(candidate => String(candidate.id) === String(block.id));
  if (!afterBlock?.hotel || afterBlock.type !== 'place') {
    throw new Error(`Post-insert verification failed: native lodging block ${block.id} not found`);
  }

  return {
    tripKey,
    sectionId: String(afterSection.id),
    sectionIndex: afterSections.findIndex(section => String(section.id) === String(afterSection.id)),
    blockId: block.id,
    blockIndex: afterSection.blocks.findIndex(candidate => String(candidate.id) === String(block.id)),
    representation: 'hotel',
    lodgingType: 'native-hotel-card',
    googlePlaceId: block.place.place_id,
    checkIn: block.hotel.checkIn,
    checkOut: block.hotel.checkOut,
    name: block.place.name,
  };
}

export async function addLodgingPlace(opts = {}, tripKey, sectionId, details = {}) {
  if (!tripKey || !sectionId) throw new UsageError('Usage: wlog lodging add-place <tripKey> <daySectionId> --query <hotel> --check-in YYYY-MM-DD --check-out YYYY-MM-DD');
  validateDate(details.checkIn, '--check-in');
  validateDate(details.checkOut, '--check-out');
  if (details.checkIn > details.checkOut) throw new UsageError('--check-in must be on or before --check-out');

  const notes = buildLodgingNotes(details);
  const common = {
    notes,
    ai: details.ai,
  };

  if (details.query) {
    const result = await enrichAddPlace(opts, tripKey, sectionId, {
      ...common,
      query: details.query,
      cost: details.cost,
      googleKey: details.googleKey,
      withPhotos: details.withPhotos,
    });
    return { ...result, representation: 'place', lodgingType: 'day-plan-place' };
  }

  const { name, lat, lng, address } = details;
  if (!name || lat == null || lng == null || !address) {
    throw new UsageError('Pass --query for Google enrichment, or pass --name --lat --lng --address for a manual lodging place');
  }
  const result = await addPlace(opts, tripKey, sectionId, {
    ...common,
    name,
    lat,
    lng,
    address,
  });
  return { ...result, representation: 'place', lodgingType: 'day-plan-place' };
}

function buildLodgingNotes(details = {}) {
  const lines = [`**Lodging:** Check-in ${details.checkIn}; check-out ${details.checkOut}.`];
  const userNotes = String(details.notes || '').trim();
  if (userNotes) lines.push(userNotes);
  return lines.join('\n');
}

async function buildHotelBlock({ ids, details, ai, userId, googleKey, fetchImpl }) {
  const placeId = await gSearch(details.query, { apiKey: googleKey, fetchImpl });
  const googleDetails = await gDetails(placeId, { apiKey: googleKey, fetchImpl });
  const legacy = toLegacy(googleDetails);
  const name = details.name || legacy.name;
  const place = pickReferenceHotelPlaceFields(legacy, { name, ai });
  const notes = buildHotelText({ name, room: details.room, notes: details.notes });
  return {
    id: uniqueId(ids),
    type: 'place',
    place,
    text: { ops: [{ insert: notes }] },
    addedBy: { type: 'user', userId },
    imageSize: 'small',
    upvotedBy: [],
    travelMode: null,
    attachments: [],
    hotel: {
      checkIn: details.checkIn,
      checkOut: details.checkOut,
      confirmationNumber: details.confirmationNumber || '',
      travelerNames: parseTravelerNames(details.travelerNames),
    },
  };
}

// Recovery for the narrow case where an unmapped native card makes the trip read fail.
// The exact old object is required by the replacement operation; no other card is touched.
export async function repairUnmapped(opts = {}, tripKey, details = {}) {
  if (!tripKey || details.confirm !== tripKey) throw new ConfirmRequiredError(`Recovery requires --confirm ${tripKey}`);
  if (!details.name || !details.query) throw new UsageError('--name and --query are required');
  const index = parseIndex(details.index, 0, 100000, 'index');
  const broken = await debugFetch(opts, tripKey);
  if (broken?.success !== false || !String(broken.error || '').includes("reading 'location'")) throw new UsageError('Trip does not exhibit the expected missing-location failure');
  const placeId = await gSearch(details.query, { apiKey: details.googleKey || opts.googleKey, fetchImpl: opts.fetch });
  const googleDetails = await gDetails(placeId, { apiKey: details.googleKey || opts.googleKey, fetchImpl: opts.fetch });
  const legacy = toLegacy(googleDetails);
  if (!Number.isFinite(legacy.geometry.location.lat) || !Number.isFinite(legacy.geometry.location.lng)) throw new UsageError('Recovery place requires valid coordinates');
  for (const key of HOTEL_PLACE_KEYS) if (legacy[key] === undefined) legacy[key] = null;
  const replacement = pickReferenceHotelPlaceFields(legacy, { name: details.name, ai: true });
  await applyTripOps(opts, tripKey, [{ p: sectionPath(index, 'blocks', 0, 'place'), od: { name: `🤵‍♂️ ${details.name}` }, oi: replacement }]);
  const sections = rawSections(await getTrip(opts, tripKey));
  const section = sections[index];
  if (section?.type !== 'hotels' || section.blocks?.[0]?.place?.name !== replacement.name || section.blocks[0].place.place_id !== replacement.place_id) {
    throw new Error('Recovery verification failed; stop and inspect the trip');
  }
  return { recovered: true, sectionId: section.id, placeName: replacement.name, formattedAddress: replacement.formatted_address };
}

function buildHotelText({ name, room, notes }) {
  const lines = [`**What:** ${name} — guesthouse / hotel.`];
  const roomText = String(room || '').trim();
  if (roomText) lines.push(roomText.endsWith('.') ? roomText : `${roomText}.`);
  const userNotes = String(notes || '').trim();
  if (userNotes) lines.push(userNotes);
  return `${lines.join('\n')}\n`;
}

function pickReferenceHotelPlaceFields(legacy, { name, ai }) {
  if (!name || !legacy.place_id || !legacy.formatted_address || !Number.isFinite(legacy.geometry?.location?.lat) || !Number.isFinite(legacy.geometry?.location?.lng)) {
    throw new UsageError('Native lodging requires a resolved place name, ID, address, and coordinates');
  }
  const place = {};
  for (const key of HOTEL_PLACE_KEYS) {
    if (key === 'name') place.name = ai ? `🤵‍♂️ ${name}` : name;
    else place[key] = legacy[key] ?? null;
  }
  return place;
}

function resolveHotelsTarget(sections, details, ids) {
  if (details.sectionId) {
    const sectionIndex = findSectionIndex(sections, details.sectionId);
    assertHotelsSection(sections[sectionIndex]);
    const blocks = sections[sectionIndex].blocks || [];
    return { sectionIndex, blockIndex: blocks.length };
  }

  const existingIndex = sections.findIndex(section => section.type === 'hotels' && section.mode === 'placeList');
  if (existingIndex !== -1) {
    const blocks = sections[existingIndex].blocks || [];
    return { sectionIndex: existingIndex, blockIndex: blocks.length };
  }

  const insertIndex = details.index == null
    ? defaultHotelsSectionIndex(sections)
    : parseIndex(details.index, 0, sections.length, 'index');
  return { sectionIndex: insertIndex, newSection: buildHotelsSection(ids) };
}

function buildHotelsSection(ids) {
  return {
    id: uniqueId(ids),
    type: 'hotels',
    mode: 'placeList',
    text: { ops: [{ insert: '\n' }] },
    heading: 'Hotels and lodging',
    placeMarkerColor: '#e67e22',
    placeMarkerIcon: 'bed',
    blocks: [],
  };
}

function assertHotelsSection(section) {
  if (!section || section.type !== 'hotels' || section.mode !== 'placeList') {
    throw new UsageError('--section-id must point to a native Hotels and lodging section (type=hotels, mode=placeList)');
  }
}

function defaultHotelsSectionIndex(sections) {
  const notesIndex = sections.findIndex(section => section.heading === 'Notes' || section.type === 'textOnly');
  return notesIndex === -1 ? 0 : notesIndex + 1;
}

function collectExistingIds(sections) {
  const ids = new Set();
  for (const section of sections) {
    if (section?.id != null) ids.add(String(section.id));
    for (const block of section?.blocks || []) {
      if (block?.id != null) ids.add(String(block.id));
    }
  }
  return ids;
}

function uniqueId(ids) {
  let id;
  do id = randomInt(100000000, 999999999);
  while (ids.has(String(id)));
  ids.add(String(id));
  return id;
}

function parseTravelerNames(value) {
  if (Array.isArray(value)) return value.map(entry => String(entry).trim()).filter(Boolean);
  return String(value || '')
    .split(/[;,]/u)
    .map(entry => entry.trim())
    .filter(Boolean);
}

function validateDate(value, label) {
  if (!DATE_RE.test(String(value || ''))) throw new UsageError(`${label} must match YYYY-MM-DD`);
}
