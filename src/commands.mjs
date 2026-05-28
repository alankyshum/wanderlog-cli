import { CLIError, UsageError } from './errors.mjs';
import { formatOutput } from './output.mjs';

const COMMANDS = new Set(['auth', 'trips', 'sections', 'places', 'calendar', 'debug']);

export function createCommandDispatcher(globalOptions = {}) {
  return {
    async execute(command, subcommand, args = []) {
      if (!COMMANDS.has(command)) throw new CLIError(`Unknown command: ${command}`, 2);
      if (globalOptions.help) return { data: helpFor(command) };

      if (command === 'auth') return dispatchAuth(globalOptions, subcommand, args);
      if (command === 'trips') return dispatchTrips(globalOptions, subcommand, args);
      if (command === 'sections') return dispatchSections(globalOptions, subcommand, args);
      if (command === 'places') return dispatchPlaces(globalOptions, subcommand, args);
      if (command === 'calendar') return dispatchCalendar(globalOptions, subcommand, args);
      if (command === 'debug') return dispatchDebug(globalOptions, subcommand, args);
      return notImplemented();
    },
  };
}

async function dispatchAuth(opts, subcommand, args) {
  const auth = await import('./auth.mjs');
  switch (subcommand) {
    case 'login':
      return ok(await auth.login(opts));
    case 'status': {
      const data = await auth.status(opts);
      if (data.authenticated) return ok(data);
      const rendered = formatOutput(data, opts);
      if (rendered) console.log(rendered);
      return { success: false, error: data.reason, exitCode: 3 };
    }
    case 'logout':
      return ok(await auth.logout(opts));
    case 'import-cookie':
      return ok(await auth.importCookie(opts));
    case 'token-path':
      return ok(await auth.tokenPath(opts));
    default:
      throw new UsageError('Usage: wlog auth <login|status|logout|import-cookie|token-path>');
  }
}

async function dispatchTrips(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const trips = await import('./trips.mjs');
  switch (subcommand) {
    case 'list':
      return ok(await trips.listTrips(opts));
    case 'get':
      return ok(await trips.getTrip(opts, args[0]));
    case 'create':
      await requireAuth(opts);
      return ok(await trips.createTrip(opts, { destination: joinArgs(args), startDate: opts.startDate || opts.start, endDate: opts.endDate || opts.end }));
    case 'rename':
      await requireAuth(opts);
      return ok(await trips.renameTrip(opts, args[0], joinArgs(args.slice(1))));
    case 'set-dates':
      await requireAuth(opts);
      return ok(await trips.setDates(opts, args[0], args[1], args[2]));
    case 'delete':
      await requireAuth(opts);
      return ok(await trips.deleteTrip(opts, args[0], { confirm: opts.confirm }));
    default:
      throw new UsageError('Usage: wlog trips <list|get|create|rename|set-dates|delete>');
  }
}

async function dispatchSections(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const sections = await import('./sections.mjs');
  await requireAuth(opts);
  switch (subcommand) {
    case 'list':
      return ok(await sections.listSections(opts, args[0]));
    case 'add':
      return ok(await sections.addSection(opts, args[0], joinArgs(args.slice(1)), { mode: opts.mode, index: opts.index }));
    case 'rename':
      return ok(await sections.renameSection(opts, args[0], args[1], joinArgs(args.slice(2))));
    case 'delete':
      return ok(await sections.deleteSection(opts, args[0], args[1], { confirm: opts.confirm }));
    case 'move':
      return ok(await sections.moveSection(opts, args[0], args[1], args[2]));
    default:
      throw new UsageError('Usage: wlog sections <list|add|rename|delete|move>');
  }
}

async function dispatchPlaces(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const places = await import('./places.mjs');
  await requireAuth(opts);
  switch (subcommand) {
    case 'search':
      return ok(await places.searchPlace(opts, joinArgs(args)));
    case 'add':
      return ok(await places.addPlace(opts, args[0], args[1], {
        name: opts.name,
        lat: opts.lat,
        lng: opts.lng,
        address: opts.address,
        notes: opts.notes,
        startTime: opts.start,
        endTime: opts.end,
        ai: !opts.noAi,
      }));
    case 'enrich-add':
      return ok(await places.enrichAddPlace(opts, args[0], args[1], {
        query: opts.query,
        notes: opts.notes,
        startTime: opts.start,
        endTime: opts.end,
        ai: !opts.noAi,
        googleKey: opts.googleKey,
      }));
    case 'update':
      return ok(await places.updatePlace(opts, args[0], args[1], args[2], collectPlaceUpdates(opts)));
    case 'delete':
      return ok(await places.deletePlace(opts, args[0], args[1], args[2], { confirm: opts.confirm }));
    case 'move':
      return ok(await places.movePlace(opts, args[0], args[1], args[2], args[3], opts.toIndex));
    case 'list':
      return ok(await places.listPlaces(opts, args[0]));
    default:
      throw new UsageError('Usage: wlog places <search|add|enrich-add|update|delete|move|list>');
  }
}

async function dispatchCalendar(opts, subcommand, args) {
  const calendar = await import('./calendar.mjs');
  switch (subcommand) {
    case 'subscribe':
      return ok(await calendar.subscribe(opts, { tripKey: args[0], alias: opts.alias, timezone: opts.timezone }));
    case 'unsubscribe':
      return ok(await calendar.unsubscribe(opts, args[0]));
    case 'list':
      return ok(await calendar.listSubscriptions(opts));
    case 'url':
      return ok(calendar.getCalendarUrl());
    case 'preview': {
      const { requireAuth } = await import('./auth.mjs');
      await requireAuth(opts);
      return ok(await calendar.previewLocal(opts, args[0]));
    }
    case 'refresh':
      return ok(await calendar.refresh(opts));
    default:
      throw new UsageError('Usage: wlog calendar <subscribe|unsubscribe|list|url|preview|refresh>');
  }
}

async function dispatchDebug(opts, subcommand, args) {
  if (subcommand === 'fetch') {
    const trips = await import('./trips.mjs');
    return ok(await trips.debugFetch(opts, args[0]));
  }
  if (subcommand === 'cleanup-ai') {
    const { requireAuth } = await import('./auth.mjs');
    const bulk = await import('./bulk.mjs');
    await requireAuth(opts);
    return ok(await bulk.cleanupAiItems(opts, args[0], { dryRun: opts.dryRun, hashPrefix: opts.hash, confirm: opts.confirm }));
  }
  throw new UsageError('Usage: wlog debug <fetch|cleanup-ai> <tripKey>');
}

function ok(data) {
  return { success: true, data };
}

function notImplemented() {
  return { success: false, error: 'not yet implemented', exitCode: 1 };
}

function collectPlaceUpdates(opts) {
  const updates = {};
  for (const key of ['name', 'address', 'notes', 'lat', 'lng']) {
    if (opts[key] !== undefined) updates[key] = opts[key];
  }
  if (opts.start !== undefined) updates.startTime = opts.start;
  if (opts.end !== undefined) updates.endTime = opts.end;
  return updates;
}

function joinArgs(args) {
  return args.filter(value => value != null).join(' ') || undefined;
}

function helpFor(command) {
  const help = {
    auth: `Usage: wlog auth <login|status|logout|import-cookie|token-path> [options]

AUTH LOGIN
  wlog auth login [--timeout 5m] [--verbose]

  Opens a real installed Chrome/Chromium/Brave/Edge window with an isolated
  temporary profile, waits for Wanderlog sign-in, captures connect.sid via CDP,
  then writes ~/.config/wanderlog/token.json. No cookie copy-paste required.

FALLBACK
  wlog auth import-cookie --cookie 'connect.sid=...'
`,
    trips: 'Usage: wlog trips <list|get|create|rename|set-dates|delete> [tripKey] [options]',
    sections: 'Usage: wlog sections <list|add|rename|delete|move> [tripKey] [options]',
    places: 'Usage: wlog places <search|add|enrich-add|update|delete|move|list> [tripKey] [options]',
    calendar: 'Usage: wlog calendar <subscribe|unsubscribe|list|url|preview|refresh> [options]',
    debug: 'Usage: wlog debug <fetch|cleanup-ai> <tripKey>',
  };
  return help[command];
}
