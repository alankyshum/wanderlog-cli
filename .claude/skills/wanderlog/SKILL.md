---
name: wanderlog
description: "Manage Wanderlog trips, itinerary sections, place blocks, lodging, or calendar feeds with wlog; triggers when those operations are requested."
---

# Goal

Manage Wanderlog trips, sections, place blocks, lodging, and the stable calendar feed with the in-repo `wlog` CLI. The consumer overview and canonical recipe are in [`README.md`](../../../README.md); this file is the detailed behavior contract.

## Installed CLI and auth

The chezmoi-managed install uses `~/.local/share/wanderlog-cli-src/` and symlinks `~/.local/bin/wlog`. Auth is stored at `~/.config/wanderlog/token.json`; run `wlog auth login` again on 401/403 or exit code 3. Login launches an isolated Chrome/Chromium/Brave/Edge profile, waits for redirect away from `/login`, and captures `connect.sid` over CDP. `--timeout 10m` extends the default; `--verbose` diagnoses browser/CDP navigation. Fallback: `wlog auth import-cookie --cookie 'connect.sid=...'`.

Google Places commands need `GOOGLE_MAPS_API_KEY` or `--google-key`; the documented 1Password source is the `wlog (wanderlog CLI) - google map places API` item in `Env-Secrets`, field `credential`. Never expose credentials.

## Command reference

| Command | Purpose |
|---|---|
| `auth login [--timeout <time>] [--verbose]` / `auth status` / `auth logout` | Browser login, validate, or remove the local token. |
| `auth import-cookie --cookie 'connect.sid=...'` / `auth token-path` | Manual fallback or print the token path. |
| `trips list` / `trips get <tripKey>` | Find and inspect trips. |
| `trips create "<destination>" [--start-date YYYY-MM-DD] [--end-date YYYY-MM-DD]` / `trips rename <tripKey> "<title>"` | Create from a geo-resolvable destination, then title it. |
| `trips set-dates <tripKey> <startDate> <endDate>` / `trips validate <tripKey> [--json] [--forbid-hotel-bookings]` | Change dates or validate structure. |
| `trips delete <tripKey> --confirm <tripKey>` | Delete a trip. |
| `sections list <tripKey>` / `sections add <tripKey> "<heading>" [--mode dayPlan|textOnly] [--index <n>]` | Inspect or add sections. |
| `sections rename <tripKey> <sectionId> "<heading>"` / `sections move <tripKey> <sectionId> <toIndex>` | Rename or reorder a section. |
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

Use `wlog --help` for the complete flags. `trips create` takes a geo-resolvable destination, not a title; rename afterward. A 500 `TypeError: Cannot read properties of undefined (reading 'length')` from a title is a client-side input error, not a server outage.

## Date sections: operational rules

There is no date, `dayIndex`, or `startDate` on a day section. Its shape is `{id, heading, mode:"dayPlan", type:"normal", blocks:[]}`. The k-th dayPlan renders `tripPlan.startDate + k days`; headings are themes and renaming in place does not detach the date. Fresh trips include Notes, Places to visit, an untitled placeList, and one untitled dayPlan per trip day. Never delete those date sections. If their count is below the trip day count, repair the broken trip; do not paper over it with arbitrary new sections.

Canonical flow: `sections list` → rename existing dayPlan IDs in date order → `places enrich-add` into those same IDs. Add `--mode dayPlan` only for genuinely more days than the date range, usually after `trips set-dates`. `validate` checks structure/render safety, not date alignment: assert count equals day count and anchor verification to the original section IDs, never offsets computed after rearrangement.

The UI repair button appends one missing section per day through `POST /api/tripPlans/<key>/applyOps`, with `{"op":"insert","path":["sections",<idx>],"value":{"id":<9-digit int>,"heading":"","mode":"dayPlan","type":"normal","blocks":[]}}` and response `{"success":true}`. Afterward rename, move blocks, and delete only stray non-date themed sections. The CLI gap is tracked in README: proposed `trips validate --check-dates` and `sections ensure-days <tripKey>`.

## Enrichment, lodging, and notes

`enrich-add` accepts `--duration`, `--cost`, `--start`, `--end`, `--notes`, `--no-ai`, `--google-key`, and `--with-photos`; duration is free-form and controls the Plan header. It maps Google Places details into the legacy place shape, inserts through `applyOps`, and verifies the target block count increased. Check each `formatted_address` against the requested branch/neighborhood and geographic cluster.

Native lodging is a `type:"place"` block in a `type:"hotels"`, `mode:"placeList"`, `heading:"Hotels and lodging"` section, with `hotel:{checkIn,checkOut,confirmationNumber,travelerNames}`—never `type:"hotel"`.

AI titles use `🤵‍♂️ <Name>`. Plain `places add` notes are only the supplied notes plus Wanderlog's trailing newline, or a blank newline when omitted. Enrichment notes prepend `**Plan**` only with duration, always `**What**`, and `**Cost**` only with cost, before user notes. The What line uses Google's primary display name and humanized type; use its English fallback when supplied, otherwise retain `<!-- TODO: add English name -->`. Keep notes durable and order-independent: identity, reason, signature thing, hours, fee, booking, or parking—not dates, times, driving, or “after lunch”.

`check-status` lists `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`, `PLACE_ID_INVALID`, and `ERR_*` by default; `UNKNOWN` requires `--show-unknown`, while `OPERATIONAL` is summarized but not listed.

## Mutation, schemas, and safety

Mutations fetch and normalize first, locate current array positions, build `applyOps`, then re-fetch. Paths are positional; invalid paths can return `success:true` without changing anything, and renderer-invalid structures can also be accepted. Validate and inspect the rendered plan after every write. Multi-ops are sequential; delete same-array indices descending. The JSON root is `tripPlan.itinerary`, not `itinerary`.

Budget expense categories are `flights`, `lodging`, `carRental`, `transit`, `food`, `drinks`, `sightseeing`, `activities`, `shopping`, `gas`, `groceries`, and `other`; unknown values can crash the Budget widget. Link an expense `blockId` to the canonical booking block, not a day-plan copy. Native hotel, flight, rental-car, checklist, and day-plan event schemas are supported by the repo docs and must not be improvised with raw API writes.

Before shipping CLI changes, run `node --test test/` and `node --test worker/test/`. See README for architecture, worker synchronization, maintainer workflow, and exit codes.
