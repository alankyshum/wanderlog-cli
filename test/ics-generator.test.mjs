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

test('generateIcs returns a VCALENDAR with visible AI-prefixed summary', () => {
  const ics = generateIcs({ trips: [baseTrip()], subscriptionVersion: 7 });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /\r\nEND:VCALENDAR\r\n$/);
  assert.match(unfold(ics), /SUMMARY:🤵‍♂️ Test Harbor Cafe/);
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

test('all-day events use DTSTART VALUE=DATE when no time is present', () => {
  const flat = unfold(generateIcs({ trips: [baseTrip()] }));
  assert.match(flat, /SUMMARY:Museum of Fixtures\r\nDTSTAMP:[^\r]+\r\nDTSTART;VALUE=DATE:20260401/);
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
