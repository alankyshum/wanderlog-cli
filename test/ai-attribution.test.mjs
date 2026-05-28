import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addAiPrefix,
  buildAiTextOps,
  formatAiPrefix,
  generateAiHash,
  parseAiPrefix,
  preserveAiPrefix,
} from '../src/ai-attribution.mjs';

test('generateAiHash returns deterministic 8+ char hex hash for seeded input', () => {
  const first = generateAiHash('Fixture Place');
  const second = generateAiHash('Fixture Place');
  assert.match(first, /^[a-f0-9]{8,}$/);
  assert.equal(first, second);
});

test('formatAiPrefix produces exact visible prefix shape', () => {
  assert.equal(formatAiPrefix('deadbeef'), '🤵‍♂️');
});

test('addAiPrefix adds a prefix when missing and does not duplicate existing prefix', () => {
  assert.equal(addAiPrefix('Fixture Cafe', 'deadbeef'), '🤵‍♂️ Fixture Cafe');
  assert.equal(addAiPrefix('[🤵‍♂️ - deadbeef] Fixture Cafe', 'badc0ffe'), '[🤵‍♂️ - deadbeef] Fixture Cafe');
  assert.equal(addAiPrefix('🤵‍♂️ Fixture Cafe', 'badc0ffe'), '🤵‍♂️ Fixture Cafe');
});

test('parseAiPrefix extracts legacy hash and bare base name', () => {
  assert.deepEqual(parseAiPrefix('[🤵‍♂️ - deadbeef] Fixture Cafe'), {
    hash: 'deadbeef',
    baseName: 'Fixture Cafe',
    format: 'legacy',
  });
  assert.equal(parseAiPrefix('Fixture Cafe'), null);
});

test('new AI prefix format uses emoji title and hash in first note line', () => {
  const name = addAiPrefix('Fixture Cafe', 'deadbeef');
  const text = buildAiTextOps('deadbeef', 'Breakfast stop');
  assert.equal(name, '🤵‍♂️ Fixture Cafe');
  assert.deepEqual(text, [{ insert: '[deadbeef]\nBreakfast stop\n' }]);
  assert.deepEqual(parseAiPrefix(name), { hash: null, baseName: 'Fixture Cafe', format: 'new' });
  assert.deepEqual(parseAiPrefix(`${name}\n${text[0].insert}`), { hash: 'deadbeef', baseName: 'Fixture Cafe', format: 'new' });
});

test('preserveAiPrefix keeps existing hash when renaming and generates one when absent', () => {
  assert.equal(
    preserveAiPrefix('[🤵‍♂️ - deadbeef] Old Name', 'New Name'),
    '🤵‍♂️ New Name',
  );
  assert.equal(preserveAiPrefix('🤵‍♂️ Old Name', 'New Name'), '🤵‍♂️ New Name');
  assert.equal(preserveAiPrefix('Old Name', 'New Name'), '🤵‍♂️ New Name');
});
