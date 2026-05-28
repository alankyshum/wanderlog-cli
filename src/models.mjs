const NEW_AI_PREFIX_RE = /^🤵‍♂️ (.+)$/u;

export function normalizeTripSummary(raw = {}) {
  return {
    id: raw.id ?? raw.planId ?? raw.key ?? null,
    key: raw.key ?? raw.planKey ?? raw.id ?? null,
    title: raw.title ?? raw.name ?? raw.destination?.name ?? null,
    startDate: raw.startDate ?? raw.start_date ?? null,
    endDate: raw.endDate ?? raw.end_date ?? null,
    destination: normalizeDestination(raw),
    updatedAt: raw.updatedAt ?? raw.updated_at ?? raw.lastUpdatedAt ?? null,
  };
}

export function normalizeTrip(raw = {}) {
  const trip = raw.tripPlan ?? raw.data?.tripPlan ?? raw.data ?? raw;
  const sections = trip.itinerary?.sections ?? trip.sections ?? [];
  return {
    id: trip.id ?? trip.planId ?? trip.key ?? null,
    key: trip.key ?? trip.planKey ?? trip.id ?? null,
    title: trip.title ?? trip.name ?? null,
    startDate: trip.startDate ?? trip.start_date ?? null,
    endDate: trip.endDate ?? trip.end_date ?? null,
    timezone: trip.timezone ?? trip.timeZone ?? trip.tripTimezone ?? null,
    destination: normalizeDestination(trip),
    sections: Array.isArray(sections) ? sections.map(normalizeSection) : [],
    raw,
  };
}

export function normalizeSection(raw = {}) {
  const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];
  return {
    id: raw.id ?? null,
    heading: raw.heading ?? raw.title ?? raw.name ?? null,
    mode: raw.mode ?? null,
    type: raw.type ?? null,
    blockCount: blocks.length,
    blocks: blocks.map((block, index) => normalizePlaceBlock(block, index)),
  };
}

export function normalizePlaceBlock(raw = {}, blockIndex = 0) {
  const place = raw.place ?? raw;
  const name = place.name ?? raw.name ?? null;
  const hash = extractAiHash(name);
  return {
    blockIndex,
    id: raw.id ?? place.id ?? place.place_id ?? null,
    type: raw.type ?? 'place',
    name,
    address: place.formatted_address ?? place.address ?? raw.address ?? null,
    lat: place.geometry?.location?.lat ?? place.location?.lat ?? raw.lat ?? null,
    lng: place.geometry?.location?.lng ?? place.location?.lng ?? raw.lng ?? null,
    notes: extractText(raw.text) ?? raw.notes ?? null,
    startTime: raw.startTime ?? raw.start_time ?? null,
    endTime: raw.endTime ?? raw.end_time ?? null,
    addedBy: raw.addedBy ?? raw.added_by ?? null,
    hasAiPrefix: hasAiPrefix(name),
    aiHash: hash,
  };
}

export function extractAiHash(name) {
  void name;
  return null;
}

export function stripAiPrefix(name) {
  if (typeof name !== 'string') return name;
  return name.match(NEW_AI_PREFIX_RE)?.[1] ?? name;
}

function hasAiPrefix(name) {
  return typeof name === 'string' && NEW_AI_PREFIX_RE.test(name);
}

function normalizeDestination(raw) {
  const dest = raw.destination ?? raw.destinations?.[0] ?? raw.geo ?? raw.geoInfo ?? null;
  if (typeof dest === 'string') return dest;
  if (!dest || typeof dest !== 'object') return raw.destinationName ?? null;
  return dest.name ?? dest.title ?? dest.formatted_address ?? null;
}

function extractText(text) {
  if (!text?.ops || !Array.isArray(text.ops)) return null;
  return text.ops.map(op => (typeof op.insert === 'string' ? op.insert : '')).join('').trim() || null;
}
