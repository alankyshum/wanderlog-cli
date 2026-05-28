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
  assert.equal(formatAiPrefix('deadbeef'), '[🤵‍♂️ - deadbeef]');
});

test('addAiPrefix adds a prefix when missing and does not duplicate existing prefix', () => {
  assert.equal(addAiPrefix('Fixture Cafe', 'deadbeef'), '[🤵‍♂️ - deadbeef] Fixture Cafe');
  assert.equal(addAiPrefix('[🤵‍♂️ - deadbeef] Fixture Cafe', 'badc0ffe'), '[🤵‍♂️ - deadbeef] Fixture Cafe');
});

test('parseAiPrefix extracts hash and bare base name', () => {
  assert.deepEqual(parseAiPrefix('[🤵‍♂️ - deadbeef] Fixture Cafe'), {
    hash: 'deadbeef',
    baseName: 'Fixture Cafe',
  });
  assert.equal(parseAiPrefix('Fixture Cafe'), null);
});

test('preserveAiPrefix keeps existing hash when renaming and generates one when absent', () => {
  assert.equal(
    preserveAiPrefix('[🤵‍♂️ - deadbeef] Old Name', 'New Name'),
    '[🤵‍♂️ - deadbeef] New Name',
  );
  assert.match(preserveAiPrefix('Old Name', 'New Name'), /^\[🤵‍♂️ - [a-f0-9]{8,}\] New Name$/);
});
