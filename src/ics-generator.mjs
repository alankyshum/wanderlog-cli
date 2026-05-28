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
    const offset = dayOffset(section);
    if (offset == null) continue;
    const eventDate = addDays(startDate, offset);
    const sectionId = section.id ?? section.sectionId ?? sectionIndex;
    const blocks = Array.isArray(section.blocks) ? section.blocks : [];
    for (const [blockIndex, block] of blocks.entries()) {
      const event = placeBlockToEvent({ block, blockIndex, eventDate, sectionId, tripKey, timezone });
      if (event) events.push(event);
    }
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

function placeBlockToEvent({ block = {}, blockIndex, eventDate, sectionId, tripKey, timezone }) {
  if (block.type && block.type !== 'place') return null;
  const name = block.name ?? block.place?.name;
  if (!name) return null;
  const blockId = block.id ?? block.blockId ?? block.blockIndex ?? blockIndex;
  const url = `https://wanderlog.com/plan/${tripKey}`;
  const startTime = normalizeTime(block.startTime ?? block.start_time);
  const endTime = normalizeTime(block.endTime ?? block.end_time);
  const timed = Boolean(startTime);
  const start = timed
    ? { kind: 'dateTime', date: formatDate(eventDate), time: timeCompact(startTime), timezone }
    : { kind: 'date', date: formatDate(eventDate) };
  const end = timed
    ? buildEndDateTime(start.date, startTime, endTime, timezone)
    : null;
  const notes = block.notes ?? extractText(block.text) ?? '';

  return {
    uid: `wlog-${safeUidPart(tripKey)}-${safeUidPart(sectionId)}-${safeUidPart(blockId)}@${CALENDAR_HOST}`,
    summary: name,
    start,
    end,
    location: block.address ?? block.formatted_address ?? block.place?.formatted_address ?? '',
    lat: block.lat ?? block.place?.geometry?.location?.lat ?? block.place?.location?.lat,
    lng: block.lng ?? block.place?.geometry?.location?.lng ?? block.place?.location?.lng,
    description: `${notes}${notes ? '\n\n' : ''}${url}`,
    url,
  };
}

function formatDtProp(name, value) {
  if (value.kind === 'date') return `${name};VALUE=DATE:${value.date}`;
  const tz = value.timezone ? `;TZID=${sanitizeTzid(value.timezone)}` : '';
  return `${name}${tz}:${value.date}T${value.time}`;
}

function buildEndDateTime(date, startTime, endTime, timezone) {
  if (endTime) {
    const startMinutes = minutesOf(startTime);
    const endMinutes = minutesOf(endTime);
    const endDate = endMinutes <= startMinutes ? addDays(compactToIso(date), 1) : date;
    return { kind: 'dateTime', date: DATE_RE.test(endDate) ? formatDate(endDate) : endDate, time: timeCompact(endTime), timezone };
  }
  const plusOneHour = addMinutes(date, startTime, 60);
  return { kind: 'dateTime', date: plusOneHour.date, time: plusOneHour.time, timezone };
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
