const PRODID = '-//alanshum//wanderlog-calendar//EN';
const CALENDAR_HOST = 'calendar.alanshum.org';
const TEXT_ENCODER = new TextEncoder();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export function generateIcs({ trips = [], calendarVersion = '0.1.0', subscriptionVersion = 0, includeAiPrefix = true, ownerName = 'Wanderlog' } = {}) {
  void includeAiPrefix;
  const dtstamp = formatDateTime(new Date());
  const events = trips.flatMap(tripToEvents);
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:' + PRODID,
    'VERSION:2.0',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:' + escapeText(`Wanderlog — ${ownerName}`),
    'X-WANDERLOG-CALENDAR-VERSION:' + escapeText(String(calendarVersion ?? '')),
    'X-WANDERLOG-SUBSCRIPTION-VERSION:' + escapeText(String(subscriptionVersion ?? 0)),
  ];

  for (const event of events) lines.push(...eventToLines(event, dtstamp));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

export function tripToEvents(trip = {}) {
  const tripKey = trip.key ?? trip.planKey ?? trip.id;
  const startDate = trip.startDate ?? trip.start_date;
  if (!tripKey || !DATE_RE.test(String(startDate))) return [];

  const timezone = trip.timezone ?? trip.timeZone ?? trip.tripTimezone ?? null;
  const sections = Array.isArray(trip.sections) ? trip.sections : [];
  const events = [];
  for (const [sectionIndex, section] of sections.entries()) {
    const eventDate = sectionEventDate(section, startDate);
    if (eventDate == null) continue;
    const sectionId = section.id ?? section.sectionId ?? sectionIndex;
    events.push(...sectionToEvents({ section, eventDate, sectionId, tripKey, timezone }));
  }
  return events;
}

export async function computeContentHash(ics) {
  const bytes = TEXT_ENCODER.encode(String(ics));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export function escapeText(value = '') {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,');
}

export function foldLine(line) {
  const text = String(line);
  let out = [];
  let current = '';
  let bytes = 0;
  for (const char of text) {
    const charBytes = TEXT_ENCODER.encode(char).length;
    const limit = current.startsWith(' ') ? 75 : 75;
    if (bytes > 0 && bytes + charBytes > limit) {
      out.push(current);
      current = ' ' + char;
      bytes = 1 + charBytes;
    } else {
      current += char;
      bytes += charBytes;
    }
  }
  out.push(current);
  return out.join('\r\n');
}

export function formatDate(value) {
  if (value instanceof Date) return dateParts(value, true).date;
  const text = String(value ?? '');
  if (DATE_RE.test(text)) return text.replaceAll('-', '');
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${text}`);
  return dateParts(parsed, true).date;
}

export function formatDateTime(value, { utc = true } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date-time: ${value}`);
  const parts = dateParts(date, utc);
  return `${parts.date}T${parts.time}${utc ? 'Z' : ''}`;
}

function eventToLines(event, dtstamp) {
  const lines = [
    'BEGIN:VEVENT',
    'UID:' + event.uid,
    'SUMMARY:' + escapeText(event.summary),
    'DTSTAMP:' + dtstamp,
    formatDtProp('DTSTART', event.start),
  ];
  const end = event.end ? formatDtProp('DTEND', event.end) : null;
  if (end) lines.push(end);
  if (event.location) lines.push('LOCATION:' + escapeText(event.location));
  if (isCoordinate(event.lat) && isCoordinate(event.lng)) lines.push(`GEO:${event.lat};${event.lng}`);
  if (event.description) lines.push('DESCRIPTION:' + escapeText(event.description));
  lines.push('URL:' + event.url, 'END:VEVENT');
  return lines;
}

// Build all events for one day/section. Blocks with explicit start/end times
// keep them; timeless blocks inherit a default-length slot from their timed
// neighbours (chaining forward from the previous timed block, or backward from
// the next one). A section with no timed blocks at all emits nothing.
function sectionToEvents({ section, eventDate, sectionId, tripKey, timezone }) {
  const dateCompact = formatDate(eventDate);
  const blocks = Array.isArray(section.blocks) ? section.blocks : [];
  const candidates = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const candidate = placeBlockToCandidate({ block, blockIndex, sectionId, tripKey });
    if (candidate) candidates.push(candidate);
  }

  // 1. Resolve blocks that carry their own times. Mark them as anchors and
  //    record which side(s) are explicit ("hard") vs an assumed default slot.
  for (const c of candidates) {
    if (c.startTime || c.endTime) {
      const moments = resolveTimedMoments(dateCompact, c.startTime, c.endTime);
      c.startMoment = moments.startMoment;
      c.endMoment = moments.endMoment;
      c.anchored = true;
      c.hardStart = Boolean(c.startTime);
      c.hardEnd = Boolean(c.endTime);
    }
  }

  // Nearest anchored block strictly after each index — the boundary that an
  // assumed duration must not run past.
  const nextAnchorStart = new Array(candidates.length).fill(null);
  let upcomingAnchor = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    nextAnchorStart[i] = upcomingAnchor;
    if (candidates[i].anchored) upcomingAnchor = candidates[i].startMoment;
  }

  // 2. Forward pass: timeless blocks between/after timed blocks chain off the
  //    previous resolved end. Assumed ends are capped inline so they never
  //    overlap the next anchored event; explicit end times are honored as-is.
  let cursorEnd = null;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c.anchored) {
      if (!c.hardEnd) {
        c.endMoment = capEndAtAnchor(c.startMoment, c.endMoment, nextAnchorStart[i]);
      }
      cursorEnd = c.endMoment;
      continue;
    }
    if (cursorEnd) {
      c.startMoment = cursorEnd;
      const rawEnd = addMomentMinutes(cursorEnd, DEFAULT_DURATION_MINUTES);
      c.endMoment = capEndAtAnchor(cursorEnd, rawEnd, nextAnchorStart[i]);
      c.hardStart = true;
      c.hardEnd = false;
      cursorEnd = c.endMoment;
    }
  }

  // 3. Backward pass: timeless blocks before any timed block chain back off the
  //    next resolved start.
  let cursorStart = null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    const c = candidates[i];
    if (c.startMoment) { cursorStart = c.startMoment; continue; }
    if (cursorStart) {
      c.endMoment = cursorStart;
      c.startMoment = addMomentMinutes(cursorStart, -DEFAULT_DURATION_MINUTES);
      cursorStart = c.startMoment;
    }
  }

  // 4. Emit only candidates that obtained a time anchor.
  const events = [];
  for (const c of candidates) {
    if (!c.startMoment) continue;
    events.push({
      ...c.event,
      start: momentToDt(c.startMoment, timezone),
      end: momentToDt(c.endMoment, timezone),
    });
  }
  return events;
}

function placeBlockToCandidate({ block = {}, blockIndex, sectionId, tripKey }) {
  if (block.type && block.type !== 'place') return null;
  const name = block.name ?? block.place?.name;
  if (!name) return null;
  const blockId = block.id ?? block.blockId ?? block.blockIndex ?? blockIndex;
  const url = `https://wanderlog.com/plan/${tripKey}`;
  const startTime = normalizeTime(block.startTime ?? block.start_time);
  const endTime = normalizeTime(block.endTime ?? block.end_time);
  const notes = block.notes ?? extractText(block.text) ?? '';
  return {
    startTime,
    endTime,
    startMoment: null,
    endMoment: null,
    event: {
      uid: `wlog-${safeUidPart(tripKey)}-${safeUidPart(sectionId)}-${safeUidPart(blockId)}@${CALENDAR_HOST}`,
      summary: deriveSummary(name, notes),
      location: block.address ?? block.formatted_address ?? block.place?.formatted_address ?? '',
      lat: block.lat ?? block.place?.geometry?.location?.lat ?? block.place?.location?.lat,
      lng: block.lng ?? block.place?.geometry?.location?.lng ?? block.place?.location?.lng,
      description: `${notes}${notes ? '\n\n' : ''}${url}`,
      url,
    },
  };
}

// Itinerary item `name` is the place/location name; the user's actual plan for
// the stop lives in the note text. Prefer the first non-empty note line (capped
// to 10 words) as the event title, falling back to the place name when the note
// is missing or empty.
function deriveSummary(name, notes) {
  const firstLine = String(notes ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(line => line.length > 0);
  if (!firstLine) return name;
  const cleaned = firstLine.replace(/^[-*\u2022\u2013\u2014]+\s+/, '').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return name;
  const title = words.slice(0, 10).join(' ');
  return words.length > 10 ? `${title}\u2026` : title;
}

function formatDtProp(name, value) {
  if (value.kind === 'date') return `${name};VALUE=DATE:${value.date}`;
  const tz = value.timezone ? `;TZID=${sanitizeTzid(value.timezone)}` : '';
  return `${name}${tz}:${value.date}T${value.time}`;
}

// Default event length when only one of start/end time is known (minutes).
const DEFAULT_DURATION_MINUTES = 120;

// A "moment" is { date: 'YYYYMMDD', time: 'HH:MM' } — a wall-clock instant in
// the trip timezone, allowing day roll-over via addMomentMinutes.
function resolveTimedMoments(dateCompact, startTime, endTime) {
  // Both present: honor them, rolling end into the next day for overnight spans.
  if (startTime && endTime) {
    const startMoment = { date: dateCompact, time: startTime };
    const overnight = minutesOf(endTime) <= minutesOf(startTime);
    const endMoment = overnight
      ? { date: formatDate(addDays(compactToIso(dateCompact), 1)), time: endTime }
      : { date: dateCompact, time: endTime };
    return { startMoment, endMoment };
  }
  // Start only: default-length event starting then.
  if (startTime) {
    const startMoment = { date: dateCompact, time: startTime };
    return { startMoment, endMoment: addMomentMinutes(startMoment, DEFAULT_DURATION_MINUTES) };
  }
  // End only: default-length event ending then.
  const endMoment = { date: dateCompact, time: endTime };
  return { startMoment: addMomentMinutes(endMoment, -DEFAULT_DURATION_MINUTES), endMoment };
}

function addMomentMinutes(moment, minutes) {
  const shifted = addMinutes(moment.date, moment.time, minutes);
  return { date: shifted.date, time: `${shifted.time.slice(0, 2)}:${shifted.time.slice(2, 4)}` };
}

// Absolute ordering value for a moment (wall-clock minutes; all moments share
// the trip timezone, so treating them as UTC is fine for comparison).
function momentValue(moment) {
  const [y, mo, d] = compactToIso(moment.date).split('-').map(Number);
  const [h, mi] = moment.time.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi) / 60000;
}

// Pull an assumed end back so it never runs past the next anchored event's
// start. Never invert the slot — clamp to a zero-length point at worst.
function capEndAtAnchor(startMoment, endMoment, anchorStart) {
  if (!anchorStart) return endMoment;
  if (momentValue(endMoment) <= momentValue(anchorStart)) return endMoment;
  return momentValue(anchorStart) > momentValue(startMoment) ? anchorStart : startMoment;
}

function momentToDt(moment, timezone) {
  return { kind: 'dateTime', date: moment.date, time: timeCompact(moment.time), timezone };
}

function sectionEventDate(section = {}, startDate) {
  const explicit = String(section.date ?? section.startDate ?? section.start_date ?? '').trim();
  if (DATE_RE.test(explicit)) return explicit;
  const offset = dayOffset(section);
  if (offset == null) return null;
  return addDays(startDate, offset);
}

function dayOffset(section = {}) {
  const heading = section.heading ?? section.title ?? section.name ?? '';
  const match = String(heading).match(/\bday\s*(\d+)\b/i);
  if (!match) return null;
  const day = Number(match[1]);
  return Number.isInteger(day) && day > 0 ? day - 1 : null;
}

function addDays(isoDate, days) {
  const [year, month, day] = String(isoDate).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addMinutes(dateCompact, time, minutes) {
  const iso = compactToIso(dateCompact);
  const [year, month, day] = iso.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute + minutes, 0));
  return { date: dateParts(date, true).date, time: dateParts(date, true).time };
}

function dateParts(date, utc) {
  const get = utc
    ? ['getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCHours', 'getUTCMinutes', 'getUTCSeconds']
    : ['getFullYear', 'getMonth', 'getDate', 'getHours', 'getMinutes', 'getSeconds'];
  const year = date[get[0]]();
  const month = date[get[1]]() + 1;
  const day = date[get[2]]();
  const hour = date[get[3]]();
  const minute = date[get[4]]();
  const second = date[get[5]]();
  return { date: `${year}${pad2(month)}${pad2(day)}`, time: `${pad2(hour)}${pad2(minute)}${pad2(second)}` };
}

function normalizeTime(value) {
  const text = String(value ?? '').trim();
  const match = text.match(TIME_RE);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${pad2(hour)}:${pad2(minute)}`;
}

function timeCompact(value) {
  return value.replace(':', '') + '00';
}

function minutesOf(value) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function compactToIso(date) {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
}

function extractText(text) {
  if (!text?.ops || !Array.isArray(text.ops)) return null;
  return text.ops.map(op => (typeof op.insert === 'string' ? op.insert : '')).join('').trim() || null;
}

function isCoordinate(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function safeUidPart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, '-');
}

function sanitizeTzid(value) {
  return String(value).replace(/[\r\n;,:]/g, '');
}

function pad2(value) {
  return String(value).padStart(2, '0');
}
