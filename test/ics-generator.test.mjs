import test from 'node:test';
import assert from 'node:assert/strict';

import fixture from './fixtures/trip-plan.json' with { type: 'json' };
import { normalizeTrip } from '../src/models.mjs';
import { computeContentHash, generateIcs } from '../src/ics-generator.mjs';

const encoder = new TextEncoder();

function baseTrip() {
  return normalizeTrip(fixture);
}

function unfold(ics) {
  return ics.replace(/\r\n[ \t]/g, '');
}

test('generateIcs returns a VCALENDAR and derives summary from the item note', () => {
  const ics = generateIcs({ trips: [baseTrip()], subscriptionVersion: 7 });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  // block-001's note is 'Breakfast and planning notes'; the place name
  // '🤵‍♂️ Test Harbor Cafe' is only the location and moves to LOCATION.
  assert.match(unfold(ics), /SUMMARY:Breakfast and planning notes/);
});

test('UID uses stable wlog trip-section-block format', () => {
  const ics = generateIcs({ trips: [baseTrip()] });
  assert.match(unfold(ics), /UID:wlog-TESTTRIP1-sec-day-1-block-001@calendar\.alanshum\.org/);
});

test('ICS uses CRLF line endings only', () => {
  const ics = generateIcs({ trips: [baseTrip()] });
  assert.equal(/\r(?!\n)|(?<!\r)\n/.test(ics), false);
  assert.ok(ics.includes('\r\n'));
});

test('folds long lines to 75 octets or fewer', () => {
  const trip = baseTrip();
  trip.sections[0].blocks[0].notes = 'Long description '.repeat(20);
  const ics = generateIcs({ trips: [trip] });
  const descriptionLines = ics.split('\r\n').filter(line => line.startsWith('DESCRIPTION:') || line.startsWith(' '));
  assert.ok(descriptionLines.some(line => line.startsWith(' ')));
  for (const line of ics.split('\r\n').filter(Boolean)) {
    assert.ok(encoder.encode(line).length <= 75, `line too long: ${line}`);
  }
});

test('escapes commas, semicolons, and newlines in text fields', () => {
  const trip = baseTrip();
  trip.sections[0].blocks[0].address = 'A, B; C';
  trip.sections[0].blocks[0].notes = 'Bring snacks, water; umbrella\nLine two';
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /LOCATION:A\\, B\\; C/);
  assert.match(flat, /DESCRIPTION:Bring snacks\\, water\\; umbrella\\nLine two/);
});

test('never emits all-day VALUE=DATE events', () => {
  const flat = unfold(generateIcs({ trips: [baseTrip()] }));
  assert.doesNotMatch(flat, /VALUE=DATE/);
});

test('timeless block after a timed block inherits a chained 2-hour slot', () => {
  // Fixture day 1: "Test Harbor Cafe" 09:00-10:30, then timeless "Museum of Fixtures".
  const flat = unfold(generateIcs({ trips: [baseTrip()] }));
  assert.match(flat, /SUMMARY:No fixed time/);
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T103000\r\nDTEND;TZID=Asia\/Seoul:20260401T123000/);
});

test('timeless block before a timed block back-fills a 2-hour slot', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [
    { id: 'b-timeless', type: 'place', place: { name: 'Early Stroll' }, startTime: null, endTime: null },
    { id: 'b-timed', type: 'place', place: { name: 'Anchor Lunch' }, startTime: '12:00', endTime: '13:00' },
  ];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Early Stroll/);
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T100000\r\nDTEND;TZID=Asia\/Seoul:20260401T120000/);
});

test('a section with no timed blocks emits no events', () => {
  const trip = baseTrip();
  trip.sections = [{
    id: 'sec-day-1',
    heading: 'Day 1 - Untimed',
    blocks: [
      { id: 'x1', type: 'place', place: { name: 'Untimed A' }, startTime: null, endTime: null },
      { id: 'x2', type: 'place', place: { name: 'Untimed B' }, startTime: null, endTime: null },
    ],
  }];
  const ics = generateIcs({ trips: [trip] });
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
});

test('start-time-only block becomes a 2-hour timed event', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [trip.sections[0].blocks[0]];
  trip.sections[0].blocks[0].startTime = '09:00';
  trip.sections[0].blocks[0].endTime = null;
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T090000/);
  assert.match(flat, /DTEND;TZID=Asia\/Seoul:20260401T110000/);
});

test('end-time-only block becomes a 2-hour timed event ending at that time', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [trip.sections[0].blocks[0]];
  trip.sections[0].blocks[0].startTime = null;
  trip.sections[0].blocks[0].endTime = '10:00';
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T080000/);
  assert.match(flat, /DTEND;TZID=Asia\/Seoul:20260401T100000/);
});

test('timed events use DTSTART date-time with TZID when timezone is set', () => {
  const flat = unfold(generateIcs({ trips: [baseTrip()] }));
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T090000/);
});

test('computeContentHash is deterministic across runs', async () => {
  const ics = generateIcs({ trips: [baseTrip()] });
  assert.equal(await computeContentHash(ics), await computeContentHash(ics));
});

test('empty sections produce no events', () => {
  const trip = { ...baseTrip(), sections: [{ id: 'empty-section', heading: 'Day 1 - Empty', blocks: [] }] };
  const ics = generateIcs({ trips: [trip] });
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
});

test('timeless block is capped so it does not overlap the next timed anchor', () => {
  // A 09:00-10:30, timeless B, then C 11:00-12:00. A naive 2h slot for B would
  // run to 12:30 and swallow C; instead B must stop at C's 11:00 start.
  const trip = baseTrip();
  trip.sections[0].blocks = [
    { id: 'a', type: 'place', place: { name: 'Anchor A' }, startTime: '09:00', endTime: '10:30' },
    { id: 'b', type: 'place', place: { name: 'Timeless B' }, startTime: null, endTime: null },
    { id: 'c', type: 'place', place: { name: 'Anchor C' }, startTime: '11:00', endTime: '12:00' },
  ];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Timeless B/);
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T103000\r\nDTEND;TZID=Asia\/Seoul:20260401T110000/);
});

test('multiple timeless blocks between anchors keep up to 2h each without overlapping', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [
    { id: 'a', type: 'place', place: { name: 'Anchor A' }, startTime: '09:00', endTime: '10:00' },
    { id: 'b', type: 'place', place: { name: 'Timeless B' }, startTime: null, endTime: null },
    { id: 'c', type: 'place', place: { name: 'Timeless C' }, startTime: null, endTime: null },
    { id: 'd', type: 'place', place: { name: 'Anchor D' }, startTime: '15:00', endTime: '16:00' },
  ];
  const flat = unfold(generateIcs({ trips: [trip] }));
  // B chains from 10:00 and keeps its full 2h (room available before D).
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T100000\r\nDTEND;TZID=Asia\/Seoul:20260401T120000/);
  // C chains from 12:00, full 2h to 14:00, still clear of D at 15:00.
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T120000\r\nDTEND;TZID=Asia\/Seoul:20260401T140000/);
});

test('timeless block is capped against the next block resolved start (end-only anchor)', () => {
  // A 09:00-10:30, timeless B, then an end-only block ending 14:00 (resolved
  // start 12:00). B must stop at 12:00, not overlap into the 12:00-14:00 slot.
  const trip = baseTrip();
  trip.sections[0].blocks = [
    { id: 'a', type: 'place', place: { name: 'Anchor A' }, startTime: '09:00', endTime: '10:30' },
    { id: 'b', type: 'place', place: { name: 'Timeless B' }, startTime: null, endTime: null },
    { id: 'c', type: 'place', place: { name: 'End Only C' }, startTime: null, endTime: '14:00' },
  ];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Timeless B/);
  assert.match(flat, /DTSTART;TZID=Asia\/Seoul:20260401T103000\r\nDTEND;TZID=Asia\/Seoul:20260401T120000/);
});

test('summary uses the first 10 words of the note, with an ellipsis when longer', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [{
    id: 'gym', type: 'place', place: { name: 'Lions Rise' },
    notes: 'Gym with SKY one two three four five six seven eight nine',
    startTime: '10:00', endTime: '11:00',
  }];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Gym with SKY one two three four five six seven\u2026/);
  // The place/location name is preserved on the LOCATION line, not the title.
  assert.doesNotMatch(flat, /SUMMARY:Lions Rise/);
});

test('summary takes only the first non-empty note line and strips a leading bullet', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [{
    id: 'k', type: 'place', place: { name: 'Lions Rise' },
    notes: '- Gym with SKY\nAddress: 123 Somewhere',
    startTime: '10:00', endTime: '11:00',
  }];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Gym with SKY/);
  assert.doesNotMatch(flat, /SUMMARY:- Gym/);
  assert.doesNotMatch(flat, /SUMMARY:Address/);
});

test('summary falls back to the place name when the note is missing', () => {
  const trip = baseTrip();
  trip.sections[0].blocks = [{
    id: 'n', type: 'place', place: { name: 'Lions Rise' },
    startTime: '10:00', endTime: '11:00',
  }];
  const flat = unfold(generateIcs({ trips: [trip] }));
  assert.match(flat, /SUMMARY:Lions Rise/);
});
