import { UsageError } from '../src/errors.mjs';

const BOOL_FLAGS = new Set([
  'help', 'version', 'json', 'verbose', 'quiet', 'no-open',
  'dry-run', 'yes', 'from-legacy', 'no-ai', 'with-photos', 'show-unknown', 'forbid-hotel-bookings', 'align-day-sections',
  'force-unowned',
]);

const VALUE_FLAGS = new Set([
  'config-dir', 'token-file', 'base-url', 'name', 'lat', 'lng', 'address',
  'notes', 'query', 'duration', 'cost', 'google-key', 'start', 'end', 'mode', 'index', 'cookie', 'browser', 'cdp-url',
  'timeout', 'user-id', 'confirm', 'start-date', 'end-date', 'check-in', 'check-out', 'to-index',
  'alias', 'timezone', 'room', 'traveler-names', 'confirmation-number', 'section-id',
  'id', 'amount', 'currency', 'category', 'description', 'date', 'paid-by', 'split-with',
  'external-id', 'owner-tag', 'expect-external-id', 'expect-description',
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
  'forbid-hotel-bookings': 'forbidHotelBookings',
  'align-day-sections': 'alignDaySections',
  'start-date': 'startDate',
  'end-date': 'endDate',
  'check-in': 'checkIn',
  'check-out': 'checkOut',
  'to-index': 'toIndex',
  'google-key': 'googleKey',
  'traveler-names': 'travelerNames',
  'confirmation-number': 'confirmationNumber',
  'section-id': 'sectionId',
  cookie: 'cookieString',
  'paid-by': 'paidBy',
  'split-with': 'splitWith',
  'external-id': 'externalId',
  'owner-tag': 'ownerTag',
  'expect-external-id': 'expectExternalId',
  'expect-description': 'expectDescription',
  'force-unowned': 'forceUnowned',
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
