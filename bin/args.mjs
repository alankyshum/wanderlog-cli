import { UsageError } from '../src/errors.mjs';

const BOOL_FLAGS = new Set([
  'help', 'version', 'json', 'verbose', 'quiet', 'no-open',
  'dry-run', 'yes', 'from-legacy', 'no-ai', 'with-photos', 'show-unknown',
]);

const VALUE_FLAGS = new Set([
  'config-dir', 'token-file', 'base-url', 'name', 'lat', 'lng', 'address',
  'notes', 'query', 'duration', 'cost', 'google-key', 'start', 'end', 'mode', 'index', 'cookie', 'browser', 'cdp-url',
  'timeout', 'user-id', 'confirm', 'start-date', 'end-date', 'to-index',
  'alias', 'timezone',
]);

const OPTION_KEYS = {
  'config-dir': 'configDir',
  'token-file': 'tokenFile',
  'base-url': 'baseUrl',
  'no-open': 'noOpen',
  'dry-run': 'dryRun',
  'cdp-url': 'cdpUrl',
  'user-id': 'userId',
  'from-legacy': 'fromLegacy',
  'no-ai': 'noAi',
  'with-photos': 'withPhotos',
  'show-unknown': 'showUnknown',
  'start-date': 'startDate',
  'end-date': 'endDate',
  'to-index': 'toIndex',
  'google-key': 'googleKey',
  cookie: 'cookieString',
};

export function parseArgs(argv) {
  const positionals = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token === '-h') {
      options.help = true;
      continue;
    }

    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf('=');
    const rawName = token.slice(2, eq === -1 ? undefined : eq);
    const key = OPTION_KEYS[rawName] || rawName;

    if (BOOL_FLAGS.has(rawName)) {
      if (eq !== -1) throw new UsageError(`Flag --${rawName} does not take a value`);
      options[key] = true;
      if (rawName === 'json') options.format = 'json';
      continue;
    }

    if (VALUE_FLAGS.has(rawName)) {
      const value = eq === -1 ? argv[++i] : token.slice(eq + 1);
      if (value === undefined || value.startsWith('--')) {
        throw new UsageError(`Flag --${rawName} requires a value`);
      }
      options[key] = value;
      continue;
    }

    throw new UsageError(`Unknown flag: --${rawName}`);
  }

  if (positionals[0] === 'version') {
    options.version = true;
    positionals.shift();
  }

  const positional = positionals.slice(2);
  return {
    command: positionals[0] || null,
    subcommand: positionals[1] || null,
    positional,
    args: positional,
    options,
  };
}
