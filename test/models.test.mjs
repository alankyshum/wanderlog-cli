import test from 'node:test';
import assert from 'node:assert/strict';

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

test('normalizePlaceBlock pulls place fields and block index', () => {
  const block = normalizePlaceBlock(fixture.tripPlan.itinerary.sections[0].blocks[0], 0);
  assert.equal(block.name, '[🤵‍♂️ - deadbeef] Test Harbor Cafe');
  assert.equal(block.lat, 33.4996);
  assert.equal(block.lng, 126.5312);
  assert.equal(block.address, '123 Example Street, Fixture City');
  assert.equal(block.notes, 'Breakfast and planning notes');
  assert.equal(block.startTime, '09:00');
  assert.equal(block.endTime, '10:30');
  assert.equal(block.blockIndex, 0);
});

test('extractAiHash and stripAiPrefix handle AI-prefixed names', () => {
  const name = '[🤵‍♂️ - deadbeef] Test Harbor Cafe';
  assert.equal(extractAiHash(name), 'deadbeef');
  assert.equal(stripAiPrefix(name), 'Test Harbor Cafe');
  assert.equal(stripAiPrefix('🤵‍♂️ Test Harbor Cafe'), 'Test Harbor Cafe');
  assert.equal(extractAiHash('Museum of Fixtures'), null);
  assert.equal(stripAiPrefix('Museum of Fixtures'), 'Museum of Fixtures');
});

test('normalizePlaceBlock reads new AI hash format from first text line', () => {
  const block = normalizePlaceBlock({
    type: 'place',
    place: { name: '🤵‍♂️ Test Harbor Cafe' },
    text: { ops: [{ insert: '[deadbeef]\nBreakfast and planning notes\n' }] },
  }, 0);
  assert.equal(block.hasAiPrefix, true);
  assert.equal(block.aiHash, 'deadbeef');
});
