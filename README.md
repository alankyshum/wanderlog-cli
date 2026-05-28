# Wanderlog CLI Maintainer Guide

This directory contains the in-repo `wlog` CLI for Wanderlog itinerary management and calendar subscription control. It is Node 22+ ESM and has no package-local runtime dependencies.

## Architecture overview

```text
.opencode/skills/wanderlog/
├── bin/
│   ├── wlog.mjs          # executable entrypoint
│   └── args.mjs          # small flag/positional parser
├── src/
│   ├── commands.mjs      # command group router
│   ├── auth.mjs          # login/status/logout/import-cookie
│   ├── browser.mjs       # Chrome/CDP cookie extraction helpers
│   ├── token-store.mjs   # ~/.config/wanderlog/token.json handling
│   ├── client.mjs        # authenticated Wanderlog HTTP client
│   ├── trips.mjs         # trip list/get/create/rename/date/delete
│   ├── sections.mjs      # section CRUD/reorder helpers
│   ├── places.mjs        # place search/add/enrich-add/update/delete/move
│   ├── calendar.mjs      # Worker admin API + local preview
│   ├── ics-generator.mjs # trip-to-ICS conversion
│   ├── models.mjs        # normalization helpers
│   ├── ai-attribution.mjs# visible AI prefix/hash utilities
│   ├── bulk.mjs          # AI cleanup utility
│   ├── errors.mjs        # typed errors and exit codes
│   └── output.mjs        # human/JSON rendering
└── test/                 # offline node:test suite and fixtures
```

## Auth design

`wlog auth login` opens the user's installed Chrome/Chromium/Brave/Edge binary at `https://wanderlog.com/login` with a temporary isolated profile, enables Chrome DevTools Protocol (CDP) on a free local port, waits for top-level navigation away from `/login`, then captures the `connect.sid` cookie with `Network.getCookies`. It does not read or modify the user's main Chrome profile, cookies, history, or already-running browser session.

Expected UX:

```bash
wlog auth login
# Opening Chrome to https://wanderlog.com/login ...
# Waiting for you to sign in (timeout: 5 min) ...
# ✓ Detected sign-in
# ✓ Cookie captured (connect.sid, expires YYYY-MM-DD)
# ✓ Wrote ~/.config/wanderlog/token.json
```

Useful flags:

- `--timeout 10m` (or milliseconds / seconds like `300000`, `30s`) extends the 5 minute default.
- `--verbose` logs Chrome spawn/CDP discovery/frame navigation details.
- Manual fallback remains `wlog auth import-cookie --cookie 'connect.sid=...'`.

If no compatible browser is found, install Google Chrome, Chromium, Brave, or Microsoft Edge and rerun `wlog auth login`.

The token store writes a schema-versioned JSON object to `~/.config/wanderlog/token.json` with `0600` file permissions and a `0700` config directory. The CLI sends cookies as a `Cookie` header; it does not print cookie values in normal output.

Auth failures from Wanderlog (`401`/`403`) are normalized to `AuthExpiredError` with exit code `3`, which tells users to run `wlog auth login` again.

## Mutation model

Mutations use fetch-before-mutate:

1. Fetch and normalize the current trip.
2. Locate the target section/place in the current raw itinerary.
3. Build `applyOps` JSON operations against the current array path.
4. Send the operation to Wanderlog.

Destructive commands require an exact `--confirm <id>` value before any network mutation. Section/place updates preserve existing AI prefixes; non-prefixed renamed items receive the visible AI marker when touched through the AI path.

AI-created/touched place names now use `🤵‍♂️ <Name>` (single space, no brackets or hash in the title). Place notes contain only user-provided notes plus Wanderlog's trailing newline, or a blank newline when omitted. Parsers remain backward-compatible with legacy names shaped like `[🤵‍♂️ - <hash>] <Name>`.

## Enriched Google Places add

Use `places enrich-add` to search Google Places v1, fetch details, map them to Wanderlog's legacy place shape, insert the block with `applyOps`, then re-fetch the trip to verify the section block count increased by one:

```bash
export GOOGLE_MAPS_API_KEY="$(op item get eryf3fv6lhqyjqiq7qqyrnjt7y --vault Env-Secrets --reveal --format json | jq -r '.fields[] | select(.label=="credential" or .purpose=="PASSWORD") | .value')"
wlog places enrich-add lpwekdgnmmcqjkjo 21652664 \
  --query "Handam Coastal Walk Aewol Jeju" \
  --start 10:30 --end 12:30
```

Flags: `--query` is required. Optional flags are `--start HH:MM`, `--end HH:MM`, `--no-ai`, `--notes "..."`, `--google-key <key>` (defaults to `$GOOGLE_MAPS_API_KEY`), and `--with-photos`.

## Where to add new commands

1. Add flag parsing in `bin/args.mjs` if the command needs new flags.
2. Add routing in `src/commands.mjs` under the appropriate command group.
3. Implement behavior in the relevant module (`trips.mjs`, `sections.mjs`, `places.mjs`, `calendar.mjs`, or a new focused module).
4. Use typed errors from `src/errors.mjs` for predictable exit codes.
5. Add offline tests under `test/` with sanitized fixtures.

Keep command modules network-isolated behind `src/client.mjs`; tests should mock `globalThis.fetch` instead of calling live services.

## Test instructions

Run CLI tests from the repository root:

```bash
node --test test/
```

Run Worker tests separately:

```bash
node --test worker/test/
```

The test suite uses only `node:test` and `node:assert/strict`. Fixtures must not include real cookies, personal data, or real trip IDs except the documented Jeju sandbox ID in docs/tests that explicitly mention it.

## Migration note from external Claude skill

The older external skill at `.claude/skills/travel/wanderlog/` used a separate script and `.env` cookie export flow. This in-repo CLI replaces that workflow with `wlog auth login`, typed modules, a secure token store, AI attribution helpers, and calendar subscription commands. Treat the external skill as reference only; do not modify it when maintaining this CLI.

## Relationship to the Worker

The Cloudflare Worker lives at `public/workers/wanderlog-calendar/` and serves the stable feed:

```text
https://calendar.alanshum.org/wanderlog
```

`src/calendar.mjs` calls the Worker admin API to subscribe/unsubscribe trips, list subscriptions, refresh the feed, and preview ICS. Worker deploys cannot import files outside their directory, so the Worker vendors copies of the model and ICS logic. Keep these in sync when changing ICS behavior:

- `src/ics-generator.mjs`
- `src/models.mjs`
- `worker/src/ics-generator.mjs`
- `worker/src/models.mjs`

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General, validation, corrupt token, network, or API error |
| 2 | Usage error or unknown command/flag |
| 3 | Authentication required or expired |
| 4 | Resource not found |
| 5 | Confirmation required |
