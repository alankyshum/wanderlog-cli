---
name: wanderlog
description: "Manage Wanderlog trips, itinerary sections, place blocks, lodging, or calendar feeds with wlog; triggers when those operations are requested."
---

# Goal

Manage Wanderlog trips, sections, place blocks, lodging, and the stable calendar feed with the in-repo `wlog` CLI. The consumer overview and canonical recipe are in [`README.md`](../../../README.md); this file is the detailed behavior contract.

## Installed CLI and auth

The chezmoi-managed install uses `~/.local/share/wanderlog-cli-src/` and symlinks `~/.local/bin/wlog`. On no-token, 401/403 or exit code 3, recover autonomously using [`reference/auth-recovery.md`](reference/auth-recovery.md), then retry the original operation. `wlog auth recover <tripKey>` handles the verified signed-in browser path and attempts Google SSO; the runbook records the signed-out limitations and fail-closed rules.

Google Places commands need `GOOGLE_MAPS_API_KEY` or `--google-key`; the documented 1Password source is the `wlog (wanderlog CLI) - google map places API` item in `Env-Secrets`, field `credential`. Never expose credentials.

## Command reference

| Command | Purpose |
|---|---|
| `auth recover <tripKey>` / `auth login [--timeout <time>] [--verbose]` / `auth status` / `auth logout` | Recover from a signed-in personal browser, isolated browser login, validate, or remove the local token. |
| `auth import-cookie` / `auth token-path` | Legacy manual import or print the token path; use `auth recover` to avoid exposing a cookie in argv. |
| `trips list` / `trips get <tripKey>` | Find and inspect trips. |
| `trips create "<destination>" [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]` / `trips rename <tripKey> "<title>"` | Create from a geo-resolvable destination, then title it. |
| `trips set-dates <tripKey> <startDate> <endDate>` / `trips validate <tripKey> [--json] [--forbid-hotel-bookings]` | Change dates or validate structure. |
| `trips delete <tripKey> --confirm <tripKey>` | Delete a trip. |
| `sections list <tripKey>` / `sections add <tripKey> "<heading>" [--mode dayPlan|placeList|textOnly] [--index <n>]` | Inspect or add sections. |
| `sections rename <tripKey> <sectionId> "<heading>"` / `sections move <tripKey> <sectionId> <toIndex>` | Rename or reorder a section. |
| `sections add-note <tripKey> <sectionId> --notes "..."` | Add a verified note to a normal day or list section. |
| `sections update-note <tripKey> <sectionId> <blockIndex> --notes "..." --expected-notes "<current text>" --confirm <blockId>` | Replace an exact unformatted note with ID and old-text guards; the server compares the section heading/date, block type and old text in the same batch (exit 8 when the note moved or changed: nothing written); re-fetch verifies (exit 7: list before retrying). |
| `sections delete <tripKey> <sectionId> --confirm <sectionId>` | Delete a section. |
| `places search "<query>"` / `places list <tripKey>` | Search or list normalized place blocks. |
| `places add <tripKey> <sectionId> --name "..." --lat <lat> --lng <lng> --address "..." [--notes "..."] [--start HH:MM] [--end HH:MM] [--no-ai]` | Add a manual place only when Google cannot resolve it. |
| `places update <tripKey> <sectionId> <blockIndex> [...]` / `places move <tripKey> <fromSectionId> <blockIndex> <toSectionId> [--to-index <n>]` | Update or move a place. |
| `places delete <tripKey> <sectionId> <blockIndex> --confirm <blockIndex>` | Delete a place. |
| `places enrich-add <tripKey> <sectionId> --query "..." [--duration "..."] [--cost "..."] [--start HH:MM] [--end HH:MM] [--notes "..."] [--no-ai] [--google-key <key>] [--with-photos]` | Google Places enrichment, insertion, and re-fetch verification. |
| `places check-status <tripKey> [--json] [--show-unknown] [--google-key <key>]` | Audit places, hotels, airports, and rental cars. |
| `lodging add <tripKey> --query "..." --check-in YYYY-MM-DD --check-out YYYY-MM-DD [--room "..."] [--traveler-names "..."] [--confirmation-number "..."] [--section-id <id>] [--index <n>]` | Native hotel card. |
| `lodging add-place <tripKey> <daySectionId> --query "..." --check-in YYYY-MM-DD --check-out YYYY-MM-DD [--notes "..."] [--cost "..."] [--with-photos]` | Normal day-plan lodging fallback. |
| `calendar subscribe <tripKey> [--alias <name>] [--timezone <tz>]` / `unsubscribe <tripKey>` / `list` / `url` / `preview <tripKey> [--timezone <tz>]` / `refresh` | Manage the stable ICS feed; admin commands need `WANDERLOG_CALENDAR_ADMIN_TOKEN`. |
| `budget list <tripKey> [--owner-tag <tag>] [--json]` | List Budget expenses with `external_id` and `owned` parsed from the description tag, plus contributor/editor ids. |
| `budget add <tripKey> --amount <n> --currency <code> --category <category> --description "..." [--date YYYY-MM-DD] [--paid-by <userId>] [--split-with <userId,userId>] [--external-id <id>] [--owner-tag <tag>] [--dry-run]` | Add one verified expense; refuses a duplicate external id (exit 6) and non-member users. |
| `budget update <tripKey> --id <expenseId> (--expect-external-id <id> \| --expect-description "<current text>") [fields] [--force-unowned] [--dry-run]` | Replace one expense using its exact old object; keeps the ownership tag; re-fetch verifies. |
| `budget remove <tripKey> --id <expenseId> (--expect-external-id <id> \| --expect-description "<current text>") [--force-unowned] [--dry-run]` | Delete one expense using its exact old object; re-fetch verifies. |

Use `wlog --help` for the complete flags. `trips create` takes a geo-resolvable destination, not a title; rename afterward. A 500 `TypeError: Cannot read properties of undefined (reading 'length')` from a title is a client-side input error, not a server outage.

## Date sections: operational rules

Day sections can carry an explicit `date`; others are positional. The k-th dayPlan must correspond to `tripPlan.startDate + k days`, and an explicit date must agree. Headings are themes and renaming in place does not detach the date. Fresh trips include Notes, Places to visit, an untitled placeList, and one untitled dayPlan per trip day. Never delete those date sections. If their count is below the trip day count, repair the broken trip; do not paper over it with arbitrary new sections.

Canonical flow: `sections list` → rename existing dayPlan IDs in date order → `places enrich-add` into those same IDs. `trips set-dates ... --align-day-sections` preserves existing day IDs, shifts their explicit dates and appends missing days; it refuses shrinking or an inconsistent original layout. Plain `set-dates` only changes trip dates. `validate` checks structure/render safety, not date alignment: assert count equals day count and anchor verification to the original section IDs, never offsets computed after rearrangement.

The UI repair button appends one missing section per day through `POST /api/tripPlans/<key>/applyOps`, with `{"op":"insert","path":["sections",<idx>],"value":{"id":<9-digit int>,"heading":"","mode":"dayPlan","type":"normal","blocks":[]}}` and response `{"success":true}`. Afterward rename, move blocks, and delete only stray non-date themed sections. The CLI gap is tracked in README: proposed `trips validate --check-dates` and `sections ensure-days <tripKey>`.

## Enrichment, lodging, and notes

`enrich-add` accepts `--duration`, `--cost`, `--start`, `--end`, `--notes`, `--no-ai`, `--google-key`, and `--with-photos`; duration is free-form and controls the Plan header. It maps Google Places details into the legacy place shape, inserts through `applyOps`, and verifies the target block count increased. Check each `formatted_address` against the requested branch/neighborhood and geographic cluster.

Native lodging is a `type:"place"` block in a `type:"hotels"`, `mode:"placeList"`, `heading:"Hotels and lodging"` section, with `hotel:{checkIn,checkOut,confirmationNumber,travelerNames}`—never `type:"hotel"`.

AI titles use `🤵‍♂️ <Name>`. Plain `places add` notes are only the supplied notes plus Wanderlog's trailing newline, or a blank newline when omitted. Enrichment notes prepend `**Plan**` only with duration, always `**What**`, and `**Cost**` only with cost, before user notes. The What line uses Google's primary display name and humanized type; use its English fallback when supplied, otherwise retain `<!-- TODO: add English name -->`. Keep notes durable and order-independent: identity, reason, signature thing, hours, fee, booking, or parking—not dates, times, driving, or “after lunch”.

`check-status` lists `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`, `PLACE_ID_INVALID`, and `ERR_*` by default; `UNKNOWN` requires `--show-unknown`, while `OPERATIONAL` is summarized but not listed.

## Mutation, schemas, and safety

Mutations fetch and normalize first, locate current array positions, build `applyOps`, then re-fetch. Paths are positional; invalid paths can return `success:true` without changing anything, and renderer-invalid structures can also be accepted. Validate and inspect the rendered plan after every write. Multi-ops are sequential; delete same-array indices descending. The JSON root is `tripPlan.itinerary`, not `itinerary`.

Budget expense categories are `flights`, `lodging`, `carRental`, `publicTransit`, `food`, `drinks`, `sightseeing`, `activities`, `shopping`, `gas`, `groceries`, and `other` (the web client's enum; there is no `transit`); unknown values can crash the Budget widget. Write expenses only with `wlog budget`: ownership is the trailing description tag ` [<owner-tag>:<external-id>]`, `update`/`remove` need `--id` plus an `--expect-*` guard, and exit 7 means a failed verification or uncertain write that must be inspected with `budget list`, never retried blindly. `budget update`/`remove` and `sections update-note` are server-checked: exit 8 means the Budget or the section changed since the fetch, nothing was written and a re-run is safe (bound it to two or three tries); exit 5 means a guard refused before any write. Known limits: other index-addressed commands (`trips rename`, `set-dates`, lodging and place edits, section rename/delete/move) still rely on client-side checks only, so do not run them while someone edits the trip in the app. See README “Guarded writes”. See README “Budget expenses”. Link an expense `blockId` to the canonical booking block, not a day-plan copy. Native hotel, flight, rental-car, checklist, and day-plan event schemas are supported by the repo docs and must not be improvised with raw API writes.

Before shipping CLI changes, run `node --test test/` and `node --test worker/test/`. See README for architecture, worker synchronization, maintainer workflow, and exit codes.
