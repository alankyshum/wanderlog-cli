import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fixture from './fixtures/trip-plan.json' with { type: 'json' };
import { extractAiHash, normalizePlaceBlock, normalizeSection, normalizeTrip, stripAiPrefix } from '../src/models.mjs';

test('normalizeTrip produces expected trip shape from fixture', () => {
  const trip = normalizeTrip(fixture);
  assert.equal(trip.key, 'TESTTRIP1');
  assert.equal(trip.title, 'Fixture Coast Trip');
  assert.equal(trip.startDate, '2026-04-01');
  assert.equal(trip.endDate, '2026-04-03');
  assert.equal(trip.sections.length, 3);
});

test('normalizeSection extracts id, heading, mode, and block count', () => {
  const section = normalizeSection(fixture.tripPlan.itinerary.sections[0]);
  assert.equal(section.id, 'sec-day-1');
  assert.equal(section.heading, 'Day 1 - Arrival');
  assert.equal(section.mode, 'dayPlan');
  assert.equal(section.blockCount, 2);
  assert.equal(section.blocks.length, 2);
});

test('normalizeSection preserves explicit dates and falls back to legacy date fields', () => {
  assert.equal(normalizeSection({ id: 1, heading: 'Day 1', date: '2026-08-03', blocks: [] }).date, '2026-08-03');
  assert.equal(normalizeSection({ startDate: '2026-08-04', blocks: [] }).date, '2026-08-04');
  assert.equal(normalizeSection({ start_date: '2026-08-05', blocks: [] }).date, '2026-08-05');
  assert.equal(normalizeSection({ blocks: [] }).date, null);
});

function extractFunction(source, name) {
  const start = source.indexOf(`export function ${name}`);
  assert.notEqual(start, -1, `missing ${name}`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `missing body for ${name}`);
  let depth = 0;
  let inString = null;
  for (let index = bodyStart; index < source.length; index += 1) {
    const character = source[index];
    const previous = source[index - 1];
    if (inString) {
      if (character === inString && previous !== '\\') inString = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      inString = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}' && --depth === 0) {
      return source.slice(start, index + 1);
    }
  }
  assert.fail(`unterminated ${name}`);
}

function normalizedFunction(source, name) {
  return extractFunction(source, name).replace(/\s+/g, ' ').trim();
}

test('vendored model normalizers stay synchronized', () => {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const cli = fs.readFileSync(path.join(root, 'src/models.mjs'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'worker/src/models.mjs'), 'utf8');
  for (const name of ['normalizeSection', 'normalizePlaceBlock', 'normalizeTripSummary']) {
    assert.equal(normalizedFunction(cli, name), normalizedFunction(worker, name), `${name} drifted between src and worker/src`);
  }
});

test('normalizePlaceBlock pulls place fields and block index', () => {
  const block = normalizePlaceBlock(fixture.tripPlan.itinerary.sections[0].blocks[0], 0);
  assert.equal(block.name, '🤵‍♂️ Test Harbor Cafe');
  assert.equal(block.lat, 33.4996);
  assert.equal(block.lng, 126.5312);
  assert.equal(block.address, '123 Example Street, Fixture City');
  assert.equal(block.notes, 'Breakfast and planning notes');
  assert.equal(block.startTime, '09:00');
  assert.equal(block.endTime, '10:30');
  assert.equal(block.blockIndex, 0);
});

test('extractAiHash and stripAiPrefix handle AI-prefixed names', () => {
  const name = '🤵‍♂️ Test Harbor Cafe';
  assert.equal(extractAiHash(name), null);
  assert.equal(stripAiPrefix(name), 'Test Harbor Cafe');
  assert.equal(stripAiPrefix('🤵‍♂️ Test Harbor Cafe'), 'Test Harbor Cafe');
  assert.equal(extractAiHash('Museum of Fixtures'), null);
  assert.equal(stripAiPrefix('Museum of Fixtures'), 'Museum of Fixtures');
});

test('legacy bracketed AI names are not treated as AI-prefixed', () => {
  const block = normalizePlaceBlock({ place: { name: '[🤵‍♂️ - deadbeef] Test Harbor Cafe' } }, 0);
  assert.equal(block.hasAiPrefix, false);
  assert.equal(block.aiHash, null);
  assert.equal(stripAiPrefix(block.name), '[🤵‍♂️ - deadbeef] Test Harbor Cafe');
});

test('normalizePlaceBlock detects new AI prefix without reading hash from text', () => {
  const block = normalizePlaceBlock({
    type: 'place',
    place: { name: '🤵‍♂️ Test Harbor Cafe' },
    text: { ops: [{ insert: 'Breakfast and planning notes\n' }] },
  }, 0);
  assert.equal(block.hasAiPrefix, true);
  assert.equal(block.aiHash, null);
  assert.equal(block.notes, 'Breakfast and planning notes');
});

test('normalizePlaceBlock does not treat note hash line as AI attribution', () => {
  const block = normalizePlaceBlock({
    type: 'place',
    place: { name: 'Test Harbor Cafe' },
    text: { ops: [{ insert: '[deadbeef]\nBreakfast and planning notes\n' }] },
  }, 0);
  assert.equal(block.hasAiPrefix, false);
  assert.equal(block.aiHash, null);
});
