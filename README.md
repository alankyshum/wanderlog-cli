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
│   ├── places.mjs        # place search/add/update/delete/move
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

`wlog auth login` obtains Wanderlog browser cookies through `src/browser.mjs` unless a cookie string is supplied. The token store writes a schema-versioned JSON object to `~/.config/wanderlog/token.json` with `0600` file permissions and a `0700` config directory. The CLI sends cookies as a `Cookie` header; it does not print cookie values in normal output.

Auth failures from Wanderlog (`401`/`403`) are normalized to `AuthExpiredError` with exit code `3`, which tells users to run `wlog auth login` again.

## Mutation model

Mutations use fetch-before-mutate:

1. Fetch and normalize the current trip.
2. Locate the target section/place in the current raw itinerary.
3. Build `applyOps` JSON operations against the current array path.
4. Send the operation to Wanderlog.

Destructive commands require an exact `--confirm <id>` value before any network mutation. Section/place updates preserve existing AI prefixes; non-prefixed renamed items receive a visible AI hash prefix when touched through the AI path.

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
node --test .opencode/skills/wanderlog/test/
```

Run Worker tests separately:

```bash
node --test public/workers/wanderlog-calendar/test/
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

- `.opencode/skills/wanderlog/src/ics-generator.mjs`
- `.opencode/skills/wanderlog/src/models.mjs`
- `public/workers/wanderlog-calendar/src/ics-generator.mjs`
- `public/workers/wanderlog-calendar/src/models.mjs`

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General, validation, corrupt token, network, or API error |
| 2 | Usage error or unknown command/flag |
| 3 | Authentication required or expired |
| 4 | Resource not found |
| 5 | Confirmation required |
