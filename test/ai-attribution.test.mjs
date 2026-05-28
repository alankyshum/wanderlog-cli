import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addAiPrefix,
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
  assert.equal(addAiPrefix('🤵‍♂️ Fixture Cafe', 'badc0ffe'), '🤵‍♂️ Fixture Cafe');
});

test('parseAiPrefix ignores unprefixed names', () => {
  assert.equal(parseAiPrefix('Fixture Cafe'), null);
});

test('parseAiPrefix does not recognize removed bracketed legacy names', () => {
  assert.equal(parseAiPrefix('[🤵‍♂️ - deadbeef] Fixture Cafe'), null);
});

test('new AI prefix format uses emoji title and plain user notes', () => {
  const name = addAiPrefix('Fixture Cafe');
  assert.equal(name, '🤵‍♂️ Fixture Cafe');
  assert.deepEqual(parseAiPrefix(name), { hash: null, baseName: 'Fixture Cafe', format: 'new' });
});

test('new AI prefix format roundtrips without a hash', () => {
  assert.deepEqual(parseAiPrefix(addAiPrefix('Foo')), { hash: null, baseName: 'Foo', format: 'new' });
});

test('preserveAiPrefix preserves AI marker when renaming new-format names', () => {
  assert.equal(preserveAiPrefix('🤵‍♂️ Old Name', 'New Name'), '🤵‍♂️ New Name');
  assert.equal(preserveAiPrefix('Old Name', 'New Name'), '🤵‍♂️ New Name');
});
