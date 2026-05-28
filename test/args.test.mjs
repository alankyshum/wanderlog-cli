import test from 'node:test';
import assert from 'node:assert/strict';

import { parseArgs } from '../bin/args.mjs';

function publicShape(parsed) {
  return {
    command: parsed.command,
    subcommand: parsed.subcommand,
    positional: parsed.positional,
    options: parsed.options,
  };
}

test('basic command parses command, subcommand, and empty positional args', () => {
  assert.deepEqual(publicShape(parseArgs(['auth', 'login'])), {
    command: 'auth',
    subcommand: 'login',
    positional: [],
    options: {},
  });
});

test('global flags parse with expected option names', () => {
  const parsed = parseArgs([
    '--json',
    '--verbose',
    '--quiet',
    '--config-dir', '/tmp/wlog-config',
    '--token-file=/tmp/token.json',
    '--base-url', 'https://example.test',
    'trips',
    'list',
  ]);
  assert.equal(parsed.command, 'trips');
  assert.equal(parsed.subcommand, 'list');
  assert.deepEqual(parsed.options, {
    json: true,
    format: 'json',
    verbose: true,
    quiet: true,
    configDir: '/tmp/wlog-config',
    tokenFile: '/tmp/token.json',
    baseUrl: 'https://example.test',
  });
});

test('per-command flags parse with camelCase option names', () => {
  const parsed = parseArgs([
    'places', 'add', 'TESTTRIP1', 'sec-day-1',
    '--alias', 'Fixture Alias',
    '--timezone', 'Asia/Seoul',
    '--confirm', 'block-001',
    '--start-date', '2026-04-01',
    '--end-date', '2026-04-03',
    '--to-index', '2',
    '--hash', 'deadbeef',
    '--no-ai',
  ]);
  assert.deepEqual(parsed.positional, ['TESTTRIP1', 'sec-day-1']);
  assert.equal(parsed.options.alias, 'Fixture Alias');
  assert.equal(parsed.options.timezone, 'Asia/Seoul');
  assert.equal(parsed.options.confirm, 'block-001');
  assert.equal(parsed.options.startDate, '2026-04-01');
  assert.equal(parsed.options.endDate, '2026-04-03');
  assert.equal(parsed.options.toIndex, '2');
  assert.equal(parsed.options.hash, 'deadbeef');
  assert.equal(parsed.options.noAi, true);
});

test('auth login browser flow flags parse', () => {
  const parsed = parseArgs(['auth', 'login', '--timeout', '10m', '--verbose']);
  assert.equal(parsed.command, 'auth');
  assert.equal(parsed.subcommand, 'login');
  assert.deepEqual(parsed.positional, []);
  assert.equal(parsed.options.timeout, '10m');
  assert.equal(parsed.options.verbose, true);
});

test('positional capture keeps delete id separate from --confirm value', () => {
  const parsed = parseArgs(['trips', 'delete', 'lpwekdgnmmcqjkjo', '--confirm', 'lpwekdgnmmcqjkjo']);
  assert.deepEqual(parsed.positional, ['lpwekdgnmmcqjkjo']);
  assert.deepEqual(parsed.args, ['lpwekdgnmmcqjkjo']);
  assert.equal(parsed.options.confirm, 'lpwekdgnmmcqjkjo');
});

test('unknown commands are parsed and rejected by dispatcher later', () => {
  const parsed = parseArgs(['not-a-command', 'sub']);
  assert.equal(parsed.command, 'not-a-command');
  assert.equal(parsed.subcommand, 'sub');
});
