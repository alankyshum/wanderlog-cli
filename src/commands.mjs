import { CLIError, UsageError } from './errors.mjs';
import { formatOutput } from './output.mjs';
import { BUDGET_USAGE } from './budget.mjs';

const COMMANDS = new Set(['auth', 'trips', 'sections', 'places', 'lodging', 'calendar', 'debug', 'budget', 'sync']);

export function createCommandDispatcher(globalOptions = {}) {
  return {
    async execute(command, subcommand, args = []) {
      if (!COMMANDS.has(command)) throw new CLIError(`Unknown command: ${command}`, 2);
      if (globalOptions.help) return { data: helpFor(command) };

      if (command === 'auth') return dispatchAuth(globalOptions, subcommand, args);
      if (command === 'trips') return dispatchTrips(globalOptions, subcommand, args);
      if (command === 'sections') return dispatchSections(globalOptions, subcommand, args);
      if (command === 'places') return dispatchPlaces(globalOptions, subcommand, args);
      if (command === 'lodging') return dispatchLodging(globalOptions, subcommand, args);
      if (command === 'calendar') return dispatchCalendar(globalOptions, subcommand, args);
      if (command === 'debug') return dispatchDebug(globalOptions, subcommand, args);
      if (command === 'budget') return dispatchBudget(globalOptions, subcommand, args);
      if (command === 'sync') return dispatchSync(globalOptions, subcommand, args);
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
    case 'recover': {
      const recovery = await import('./recover.mjs');
      return ok(await recovery.recover(opts, args[0]));
    }
    case 'token-path':
      return ok(await auth.tokenPath(opts));
    default:
      throw new UsageError('Usage: wlog auth <login|status|logout|import-cookie|recover|token-path>');
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
      return ok(await trips.setDates(opts, args[0], args[1], args[2], { alignDaySections: Boolean(opts.alignDaySections) }));
    case 'validate': {
      await requireAuth(opts);
      const result = await trips.validateTrip(opts, args[0], { forbidHotelBookings: Boolean(opts.forbidHotelBookings), checkDates: Boolean(opts.checkDates) });
      // With --check-dates the command is a fence: an invalid trip exits 1 after printing the result.
      if (opts.checkDates && !result.valid) {
        const rendered = formatOutput(result, opts);
        if (rendered) console.log(rendered);
        return { success: false, error: 'Trip structure invalid', exitCode: 1 };
      }
      return ok(result);
    }
    case 'fetch': {
      await requireAuth(opts);
      const sync = await import('./sync-cli.mjs');
      return ok(await sync.fetchRedacted(opts, args[0]));
    }
    case 'delete':
      await requireAuth(opts);
      return ok(await trips.deleteTrip(opts, args[0], { confirm: opts.confirm }));
    default:
      throw new UsageError('Usage: wlog trips <list|get|create|rename|set-dates|validate|fetch|delete>');
  }
}

async function dispatchLodging(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const lodging = await import('./lodging.mjs');
  await requireAuth(opts);
  switch (subcommand) {
    case 'add':
      return ok(await lodging.addLodging(opts, args[0], {
        query: opts.query,
        name: opts.name,
        notes: opts.notes,
        room: opts.room,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        confirmationNumber: opts.confirmationNumber,
        travelerNames: opts.travelerNames,
        sectionId: opts.sectionId,
        index: opts.index,
        ai: !opts.noAi,
        googleKey: opts.googleKey,
      }));
    case 'add-place':
      return ok(await lodging.addLodgingPlace(opts, args[0], args[1], {
        query: opts.query,
        name: opts.name,
        lat: opts.lat,
        lng: opts.lng,
        address: opts.address,
        notes: opts.notes,
        cost: opts.cost,
        checkIn: opts.checkIn,
        checkOut: opts.checkOut,
        ai: !opts.noAi,
        googleKey: opts.googleKey,
        withPhotos: Boolean(opts.withPhotos),
      }));
    case 'repair-unmapped':
      return ok(await lodging.repairUnmapped(opts, args[0], { confirm: opts.confirm, index: opts.index, name: opts.name, query: opts.query, googleKey: opts.googleKey }));
    default:
      throw new UsageError('Usage: wlog lodging <add|add-place> <tripKey> [sectionId] --query <hotel> --check-in YYYY-MM-DD --check-out YYYY-MM-DD');
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
    case 'add-note':
      return ok(await sections.addNote(opts, args[0], args[1], opts.notes));
    case 'update-note':
      return ok(await sections.updateNote(opts, args[0], args[1], args[2], opts.notes, { confirm: opts.confirm, expectedNotes: opts.expectedNotes }));
    case 'delete':
      return ok(await sections.deleteSection(opts, args[0], args[1], { confirm: opts.confirm }));
    case 'move':
      return ok(await sections.moveSection(opts, args[0], args[1], args[2]));
    default:
      throw new UsageError('Usage: wlog sections <list|add|rename|add-note|update-note|delete|move>');
  }
}

async function dispatchPlaces(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const places = await import('./places.mjs');
  if (subcommand === 'check-status') {
    const result = await places.checkPlaceStatuses(opts, args[0], { googleKey: opts.googleKey, showUnknown: opts.showUnknown });
    if (opts.format === 'json' || opts.json) return ok(result);
    return ok(places.formatCheckStatusReport(result));
  }
  if (subcommand === 'resolve') return ok(await places.resolvePlace({ query: opts.query, placeId: opts.placeId, googleKey: opts.googleKey }));
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
        duration: opts.duration,
        cost: opts.cost,
        startTime: opts.start,
        endTime: opts.end,
        ai: !opts.noAi,
        googleKey: opts.googleKey,
        withPhotos: Boolean(opts.withPhotos),
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
      throw new UsageError('Usage: wlog places <search|resolve|add|enrich-add|check-status|update|delete|move|list>');
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
    case 'render': {
      const ics = await (await import('./calendar-file.mjs')).render(opts);
      if (opts.format === 'json') return ok({ ics });
      process.stdout.write(ics);
      return { success: true };
    }
    case 'publish':
      return ok(await (await import('./calendar-file.mjs')).publish(opts, args[0]));
    default:
      throw new UsageError('Usage: wlog calendar <subscribe|unsubscribe|list|url|preview|refresh|render|publish>');
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
    return ok(await bulk.cleanupAiItems(opts, args[0], { dryRun: opts.dryRun, confirm: opts.confirm }));
  }
  throw new UsageError('Usage: wlog debug <fetch|cleanup-ai> <tripKey>');
}

async function dispatchBudget(opts, subcommand, args) {
  const { requireAuth } = await import('./auth.mjs');
  const budget = await import('./budget.mjs');
  await requireAuth(opts);
  return ok(await budget.runBudgetCommand(opts, subcommand, args));
}

async function dispatchSync(opts, subcommand, args) {
  const sync = await import('./sync-cli.mjs');
  // plan --snapshot is offline; everything else needs a session. A missing session is the
  // contract's exit 4 (fetch or auth failure), reported as JSON like every other outcome.
  if (!(subcommand === 'plan' && opts.snapshot) && ['plan', 'apply', 'restore'].includes(subcommand)) {
    const { requireAuth } = await import('./auth.mjs');
    try {
      await requireAuth(opts);
    } catch (err) {
      return { success: true, ...sync.failure(4, `${err?.message ?? err}; run wlog auth recover, then re-run once`) };
    }
  }
  return { success: true, ...(await sync.runSync(opts, subcommand, args)) };
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
    auth: `Usage: wlog auth <login|status|logout|import-cookie|recover|token-path> [options]

AUTH RECOVER
  wlog auth recover <tripKey>

  Reuse the verified signed-in personal browser, capture connect.sid in memory,
  validate the selected account and fetch the specified trip. See the runbook
  for the guarded signed-out Google SSO path and its current limitations.

AUTH LOGIN
  wlog auth login [--timeout 5m] [--verbose]

  Opens a real installed Chrome/Chromium/Brave/Edge window with an isolated
  temporary profile, waits for Wanderlog sign-in, captures connect.sid via CDP,
  then writes ~/.config/wanderlog/token.json. No cookie copy-paste required.

FALLBACK
  wlog auth import-cookie --cookie 'connect.sid=...'
`,
    trips: `Usage: wlog trips <list|get|create|rename|set-dates|validate|fetch|delete> [tripKey] [options]

  validate <tripKey> [--check-dates] [--forbid-hotel-bookings] [--json]
      Structure check. --check-dates also requires one dayPlan section per trip day, dated
      startDate + i in order; with --check-dates an invalid trip exits 1.
  fetch <tripKey> --redacted --out <file>
      Writes the trip document to a private (0600) file with editKey, viewKey, suggestKey,
      journalKey and every TripPlanKeys key replaced by [REDACTED].
  delete <tripKey> --confirm <tripKey>
      Moves the trip to Wanderlog's Trash; it is not deleted permanently. Permanent deletion is
      only in the web UI (Trash, then Delete permanently).`,
    sections: 'Usage: wlog sections <list|add|rename|add-note|update-note|delete|move> [tripKey] [options]\n  add-note <tripKey> <sectionId> --notes <text>\n  update-note <tripKey> <sectionId> <blockIndex> --notes <text> --expected-notes <old text> --confirm <blockId>',
    places: `Usage: wlog places <search|add|enrich-add|check-status|update|delete|move|list> [tripKey] [options]

ENRICH ADD
  wlog places enrich-add <tripKey> <sectionId> --query <text> [--duration <text>] [--cost <text>] [--notes <text>]

  Searches Google Places v1, inserts an enriched place block, and auto-prepends notes headers:
  **Plan ~<duration>.**  (only when --duration is provided; omitted otherwise)
  **What:** <Google displayName> — <human Google type>.
  **Cost:** <cost>.  (only when --cost is provided)

  Options: --query, --duration, --cost, --notes, --start HH:MM, --end HH:MM, --no-ai,
  --google-key <key>, --with-photos.

CHECK STATUS
  wlog places check-status <tripKey> [--json] [--show-unknown] [--google-key <key>]

  Sweeps itinerary place IDs for Google business status issues.
  Shows CLOSED_TEMPORARILY, CLOSED_PERMANENTLY, PLACE_ID_INVALID, and ERR_* by default.
   Hides UNKNOWN rows (places without businessStatus/business profile) unless --show-unknown is passed.
   OPERATIONAL rows are never listed, but are counted in the summary.`,
    lodging: `Usage: wlog lodging add <tripKey> --query <hotel> --check-in YYYY-MM-DD --check-out YYYY-MM-DD [options]

Adds a native Wanderlog hotel card in a type=hotels / mode=placeList section,
using the reference-derived schema: a type=place block with Google place details
and hotel.{checkIn,checkOut,confirmationNumber,travelerNames}.

Options: --query, --name, --check-in, --check-out, --room, --traveler-names,
--confirmation-number, --section-id, --index, --notes, --no-ai, --google-key.

Fallback: wlog lodging add-place <tripKey> <daySectionId> adds lodging as a
normal day-plan place block when native hotel cards are not desired.`,
    calendar: 'Usage: wlog calendar <subscribe|unsubscribe|list|url|preview|refresh|render|publish> [options]\n  render --events F               print the ICS for a file events document (docs/calendar-events.md)\n  publish <trip> --events F [--json]  PUT the events to the Worker, then verify the feed equals the local render',
    debug: 'Usage: wlog debug <fetch|cleanup-ai> <tripKey>',
    sync: `Usage: wlog sync <plan|apply|restore> <tripKey> [options] --json

  plan <tripKey> [--desired F] [--last LOCK] [--snapshot S] [--out-snapshot P] [--out-report R]
      Read-only. Fetches (or reads --snapshot), normalises, diffs the desired document by id,
      classifies drift against the lock (one fingerprint per change) and lists refusals.
      Writes P (redacted fetch) and R (drift report, with --last). Exit 0, or 3 on a refusal.
  apply <tripKey> --desired F --last LOCK --expect-version N [--ack-drift R] [--out-snapshot P]
      Exit 8 if overallVersion != N, 3 on a refusal, 10 on drift whose fingerprint is not in R.
      Otherwise one guarded batch, then a re-fetch: managed sections must equal desired and
      overallVersion must be N + 1 (else exit 7, never retried). A compare refusal is exit 5.
  restore <tripKey> --from-snapshot S --last LOCK --target-lock T --expect-version N [--ack-drift R] [--out-snapshot P]
      Puts the sections managed in LOCK or T back to their content in S through the same gates.

  Every outcome is one JSON document on stdout. Exit codes: 0 done, 2 bad input, 3 refused,
  4 fetch or auth failure, 5 batch refused by the server, 7 uncertain, 8 version changed,
  10 unacknowledged drift.`,
    budget: BUDGET_USAGE,
  };
  return help[command];
}
