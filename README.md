# Wanderlog CLI

wlog manages Wanderlog trips, sections, and places, generates ICS calendars, and controls calendar subscriptions through a Worker admin API. It supports an isolated Chrome login and recovery from the verified personal-login Chrome session; it runs on Node 22+ ESM with no package-local runtime dependencies.

<img width="1344" height="752" alt="file-e3b73864587e96c48c6b062cf16064ae" src="https://github.com/user-attachments/assets/222feadf-5454-4c40-8539-4df68b0b436a" />


## Install and authenticate

The chezmoi-managed install places this repository at `~/.local/share/wanderlog-cli-src/`, symlinks `~/.local/bin/wlog`, and stores the token at `~/.config/wanderlog/token.json` (directory `0700`, file `0600`).

```bash
wlog --version
wlog auth recover <tripKey>
wlog auth status
```

On no-token, 401/403, or exit code 3, use `wlog auth recover <tripKey>`. It verifies the launchd-owned personal-login Chrome, the Wanderlog account, and a requested trip, and imports the existing session in memory without putting a cookie on the command line. The selected Wanderlog identity is `alan200994@gmail.com`, not the default Google identity; the Wanderlog SSO item is `6xpucouavjlay33njoylvlam2e`, and the matching Google credential item is `vcwlhi4y3req5pma2ug6tt5xou` in Env-Secrets. The signed-out Wanderlog / signed-in Google path was verified live; Google password and authenticator-app challenges are not yet automated. Follow the [auth recovery runbook](.claude/skills/wanderlog/reference/auth-recovery.md). `auth login` remains the isolated-profile interactive flow; do not start a duplicate stale login. Never print, log, or write plaintext passwords, TOTP codes, or cookies outside the CLI's protected token store.

Google Places commands (`places enrich-add`, `lodging add`, and `places check-status`) require `GOOGLE_MAPS_API_KEY` or `--google-key`. The documented key is in 1Password, item `wlog (wanderlog CLI) - google map places API`, vault `Env-Secrets`, field `credential`:

```bash
export GOOGLE_MAPS_API_KEY="$(op read 'op://Env-Secrets/26e6zxdbj5ndyk6ay2blqk7r6i/credential')" <!-- skill-lint: allow -->
```

Never print or write the key, token, or cookie.

## Canonical one-shot itinerary recipe

For “create an itinerary for <trip>”, use the destination and title as separate concepts. `trips create` resolves argument 1 through geo-autocomplete; it does **not** take a title.

```bash
wlog trips list
wlog trips create "<resolvable destination>" --start-date YYYY-MM-DD --end-date YYYY-MM-DD
wlog trips rename <tripKey> "<human-readable title>"
wlog sections list <tripKey>
# Rename existing untitled dayPlan sections in date order; do not add replacements.
wlog sections rename <tripKey> <daySectionId1> "<day 1 theme>"
wlog sections rename <tripKey> <daySectionId2> "<day 2 theme>"
# Add each POI to the same existing section id as its day.
wlog places enrich-add <tripKey> <daySectionId> --query "<place>" --notes "<durable essence>"
wlog trips validate <tripKey> --json
wlog trips get <tripKey>
```

Verify every enriched result's `formatted_address` against the requested neighborhood or branch and the day's geographic cluster. Flag a multi-branch chain or conflicting address instead of writing a contradictory note.

## Date-section model (canonical)

Some `dayPlan` sections have an explicit `date`; others are represented positionally. The k-th day section must correspond to `tripPlan.startDate + k days`, and any explicit date must agree. Renaming a dayPlan heading does not detach its date: the UI can show a date header with the theme as a subheading, and the sidebar can show `Mon 3/8: Drive Down the 5`.

A fresh trip ships with `Notes` (`textOnly`), `Places to visit` (`placeList`), an untitled `placeList`, and one untitled empty `dayPlan` section per trip day. Those untitled dayPlan sections are the dates. Never delete them. If `count(dayPlan sections) < trip day count`, the trip is broken and Wanderlog shows “Your itinerary is missing sections for the dates of your trip.”

The safe population flow is `sections list` → `sections rename <existing sectionId> "<Theme>"` in date order → `places enrich-add` into those same IDs. `trips set-dates ... --align-day-sections` updates existing explicit dates and appends the missing days without deleting existing IDs; it refuses to shrink or shift an already inconsistent layout. Plain `set-dates` changes only trip dates. Keep unused date slots empty rather than adding filler.

Plain `wlog trips validate` may return `valid:true` for broken date layouts. `wlog trips validate <tripKey> --check-dates` also requires one `normal/dayPlan` section per trip day, dated `startDate + i` in order, and exits 1 when the trip is invalid. Still verify rendered dates against the **original date-bound section IDs**. Never compute offsets over sections you just rearranged—that is circular.

### Repairing an already-broken trip

The UI's “Create the sections for me” button is client-side React behavior that auto-saves via `POST /api/tripPlans/<key>/applyOps`. It appends one operation per missing day, with this value:

```json
{"op":"insert","path":["sections",<idx>],"value":{"id":<9-digit int>,"heading":"","mode":"dayPlan","type":"normal","blocks":[]}}
```

The response is `{"success":true}`. After regeneration, rename the new sections in date order, move blocks into them with `places move`, then delete only stray non-date themed sections. Never delete the original date-bound sections. `wlog trips validate --check-dates` detects missing or misdated day sections; the CLI cannot regenerate them. Durable TODO: implement `wlog sections ensure-days <tripKey>` (append exactly the payload above, do not reorder/delete existing sections, re-fetch and verify).

## Safety and durable notes

- `trips create` sends the body the web app sends (`type: "plan"`, `initialMapsPlaceIds: []`, …); before 2026-11-17 it sent `type: "tripPlan"` without `initialMapsPlaceIds`, the server answered `success:false` (`TypeError: Cannot read properties of undefined (reading 'length')`) and the CLI printed a trip of nulls. A `success:false` answer now fails with the server's error type.
- `trips delete` moves the trip to Wanderlog's Trash; a trashed trip already reads as `tripPlanNotFound`. Permanent deletion is only in the web UI: Trash, select the trip, Delete permanently.
- `trips fetch <tripKey> --redacted --out F` writes a private (0600) snapshot with `editKey`, `viewKey`, `suggestKey`, `journalKey` and every `TripPlanKeys[].key` replaced by `[REDACTED]`. `debug fetch` stays unredacted; never save its output.
- `places resolve (--query Q | --place-id ID) --json` returns `{place_id, name, formatted_address, lat, lng, types, plan_place: {google_id, address, lat, lng}}` from Google Places only (no Wanderlog read or write). Key: `--google-key`, `GOOGLE_MAPS_API_KEY`, else `GOOGLE_API_KEY`.
- List trips and sections before mutation; fetch and validate after every write. `applyOps` can return `success:true` for an invalid/no-op or renderer-breaking write.
- Destructive commands require the exact `--confirm <id>` value. Never drive the browser or call raw APIs as a shortcut around the CLI workflow.
- Prefer Google-enriched POIs. Check `formatted_address`, especially for multi-branch chains, before accepting a result.
- AI-created/touched place titles use `🤵‍♂️ <Name>`. `enrich-add` prepends `**Plan**` only with `--duration`, always adds `**What**`, and adds `**Cost**` only with `--cost`, before user notes. Notes should describe durable essence, not “after lunch”, “on the way back”, dates, times, or driving order.
- Native lodging uses `lodging add`: a `type:"hotels"`, `mode:"placeList"`, `heading:"Hotels and lodging"` section with `type:"place"` blocks and `hotel:{checkIn,checkOut,confirmationNumber,travelerNames}`. It is not a `type:"hotel"` block; `lodging add-place` is the day-plan fallback.
- `sections add <tripKey> "..." --mode placeList` creates a normal list; `sections add-note <tripKey> <sectionId> --notes "..."` adds a text block to a normal day or list section.
- `sections update-note <tripKey> <sectionId> <blockIndex> --notes "..." --expected-notes "<current text>" --confirm <blockId>` replaces only an exact, unformatted note, checking its ID and old text and re-fetching afterward; formatted notes are refused. The write is server-checked: one batch that makes Wanderlog compare the section's heading and date, the block's type and the note's old text at that index before replacing the text, so a note that moved or changed since the fetch is never touched (exit 8: nothing written, safe to re-run). A note that another block could pass for (same section heading and date, a note whose text starts with the same text) is refused before any write (exit 5, as is a wrong `--confirm`; an `--expected-notes` that does not match the fetched text exits 2). A failure after the write was accepted exits 7: run `sections list` and look at the note before retrying. See “Guarded writes”.
- `trips set-dates <tripKey> <start> <end> --align-day-sections` preserves existing day IDs, shifts explicit day dates when present, and appends missing days atomically; it refuses to remove days or realign an already inconsistent layout. Re-fetch and verify rendered dates.
- `check-status` reports actionable closed/invalid/error rows by default; `UNKNOWN` rows are hidden unless `--show-unknown`, and `OPERATIONAL` rows are counted but not listed.

See `.claude/skills/wanderlog/SKILL.md` for the full command table, flags, auth runbook, schemas, notes convention, check-status semantics, applyOps gotchas, and troubleshooting signatures.

## Budget expenses

`wlog budget` manages `tripPlan.itinerary.budget.expenses` with one guarded JSON0 op per command.

```bash
wlog budget list <tripKey> --json
wlog budget add <tripKey> --amount 1.23 --currency USD --category food --description "Lunch" \
  --date YYYY-MM-DD --paid-by <userId> [--split-with <userId,userId>] [--external-id <id>] [--owner-tag <tag>]
wlog budget update <tripKey> --id <expenseId> --expect-external-id <id> [--amount N] [--currency CODE] \
  [--category C] [--description TEXT] [--date YYYY-MM-DD] [--paid-by <userId>] [--split-with <ids>]
wlog budget remove <tripKey> --id <expenseId> --expect-external-id <id>
```

- **Categories** are exactly Wanderlog's web-client enum: `flights`, `lodging`, `carRental`, `publicTransit`, `food`, `drinks`, `sightseeing`, `activities`, `shopping`, `gas`, `groceries`, `other`. Anything else is refused (there is no `transit`); an unknown category can break the Budget widget.
- **Ownership** is a trailing description tag, ` [<owner-tag>:<external-id>]` (owner tag default `tf`), because expenses have no free-text note field. `list --json` returns `description` without the tag, `raw_description`, `owner_tag`, `external_id` and `owned` (true when the tag's owner matches `--owner-tag`). `add` refuses a second expense with the same owner tag and external id (exit 6), so a mirror run is idempotent.
- **Guards**: `update` and `remove` need `--id` and either `--expect-external-id` (must equal the tag) or `--expect-description` (the exact current description, tag included). An expense without the caller's tag is refused unless `--force-unowned` is added to the guard. `update` keeps the tag and sends nothing when no field would change.
- **People**: `--paid-by` (default: the logged-in user) and every `--split-with` id must be a contributor or editor of the trip. The default split is all contributors. A split is stored as `{"type":"individuals","users":[{"type":"registered","id":<userId>}]}` and divided equally among the listed users.
- **Dates**: `--date` is stored as `associatedDate` (the day the expense applies to); `date` is the creation day, as in the web client.
- **Currency** must be a code in the trip response's `resources.currencyRatesUSD` table.
- **Verification**: each mutation fetches the trip, computes the index from that fresh array, posts one op batch, re-fetches, and checks the target expense, every other expense, `payments` and the budget amount. `update` and `remove` put server-side compares of the expense's description, category, dates and currency in front of the change in the same batch, so an expense that moved or changed since the fetch is never touched (exit 8: nothing written, safe to re-run); an expense without a description, or one that another expense could pass for, is refused before any write (exit 5). A failed check or an uncertain write (network error or 5xx) exits 7 and is never retried: run `budget list` before deciding what to do. `--dry-run` prints the ops without writing. See “Guarded writes”.

## Guarded writes

Wanderlog's `applyOps` endpoint takes list indexes and does not compare the old value of a delete or replace, so an index taken from a fetch can point at a neighbour once the phone app has added or removed something. It does check a `text0` string component, and it refuses a whole batch when one component fails. `budget update`, `budget remove` and `sections update-note` use that: compares on the target's string fields go in front of the change, in the same batch.

- **Exit 8** (the Budget or the section changed since the fetch): Wanderlog refused the batch and nothing was written. Re-running is safe; the command fetches again. Bound the retries (two or three), then stop and report, because repeated refusals mean someone is editing the trip.
- **Exit 7** (verification failed or the write outcome is uncertain): the write may have been applied. Never retry blindly: list first (`budget list`, `sections list` or `debug fetch`) and compare with what was intended.
- **Exit 5**: a guard refused before any write (wrong `--confirm` or `--expect-*`, an unowned expense, or a target the server could not tell from another one). Nothing was written; a re-run gives the same answer until the input or the trip changes.
- The compare is a prefix compare of strings only. Numbers (ids, amounts) cannot be compared, and a string that grew at its end still passes; the re-fetch after the write catches that case as exit 7.

## Trip-file sync (`wlog sync`)

The vault's `trip_sync.py` derives `desired.json` from a trip folder; `wlog sync` makes the trip's managed sections match it. The contract (calls, JSON, exit codes, normal form, drift) is the vault's `trip-plan/reference/sync-cli-contract.md`; its executable reference is the vault's `fake_sync_wlog.py`, whose outputs `test/fixtures/sync/vectors.json` records (`gen_vectors.py` regenerates it).

```bash
wlog sync plan    <tripKey> [--desired D] [--last LOCK] [--snapshot S] [--out-snapshot P] [--out-report R] --json
wlog sync apply   <tripKey> --desired D --last LOCK --expect-version N [--ack-drift R] [--out-snapshot P] --json
wlog sync restore <tripKey> --from-snapshot S --last LOCK --target-lock T --expect-version N [--ack-drift R] [--out-snapshot P] --json
```

- **plan** is read-only. It fetches (or reads `--snapshot`), resolves `id: null` sections (a day section by its date, Notes and Hotels by type; ambiguous or missing is refused) and a `new` Hotels section (the trip's one existing Hotels section takes its place; two are refused), diffs by id, and classifies drift against the lock with one fingerprint per change. Stdout: `{version, op_count, ops, drift, refusals, hashes, matched, resolved}`. `P` is the redacted fetch; `R` (`{trip, version, snapshot, drift}`) is written only with `--last`.
- **apply** refuses before any write: exit 8 when `overallVersion` ≠ `N`; exit 3 on a structural refusal; exit 10 when a drift fingerprint is missing from `R`. It then builds one batch: `text0` compares first (each touched section's heading and day date, and one identity string per current block: place name, first text op, checklist title), then `blocks` array replaces (ids kept, unmodelled fields carried), heading and Notes text sets, list deletes and list inserts (just before the first day section). A `new` Hotels section that Wanderlog lacks is inserted right after the Notes section (else before the first day) in the web app's native shape: `{id, type: "hotels", mode: "placeList", heading, text: {ops: [{insert: "\n"}]}, placeMarkerColor: "#e67e22", placeMarkerIcon: "bed", blocks}`, no `date` key (as `lodging add` and the real December trip's Hotels section). Before posting it checks every new or rewritten block for the required fields (below), simulates the batch locally and refuses (exit 3) unless the simulated trip is valid and equal to desired. After the post it re-fetches: managed sections must equal desired and `overallVersion` must be `N + 1`, else exit 7. Nothing is retried. Stdout: `{version_before, version_after, verified, ops_applied, components, hashes, matched, resolved}`.
- **restore** puts the sections managed in `LOCK` or `T` back to their raw content in `S`, deletes managed list sections that `S` lacks and re-inserts managed sections `S` has; other sections are untouched. Its drift gate compares Wanderlog with `LOCK` only, so its `--ack-drift` report must come from `sync plan --last LOCK` **without** `--desired`.
- **Exit codes** (sync only): 0 done, 2 bad input, 3 refused (nothing written), 4 fetch or auth failure, 5 the server refused the batch on a compare (nothing written), 7 uncertain or verify mismatch (inspect before anything else), 8 version changed since `plan` (re-capture), 10 unacknowledged drift. Every outcome, failures included, is one JSON document on stdout.
- **Who fills Wanderlog's own fields**: the CLI. `desired.json` carries only modelled fields; the CLI adds the native set the web UI gives a new block, using the trip owner's `tripPlan.userId`: place `{id, type, place, text, addedBy: {type: "user", userId}, imageSize: "small", upvotedBy: [], travelMode: null, attachments: [], imageKeys: []}` plus `startTime`/`endTime` when timed (a new place without a Google id gets `place_id: null`, `types: ["point_of_interest"]`); note `{id, type, text, addedBy, attachments: []}`; checklist `{id, type, title, items: [{id, checked, text}], attachments: [], addedBy}`; a hotel card also gets `hotel.travelerNames: []`. A rewritten existing block keeps every field the plan does not model, and gains any of these it lacked; if its Google place id changed, the old Google fields are dropped. A place block with only id/type/place/text once broke a real trip permanently, hence the hard pre-post check.
- **Deliberate differences from the reference fake**: a `new` block, row or section whose id already sits in Wanderlog in the same place is treated as a landed write (not re-inserted, not reported in `matched`); the same id anywhere else is refused. Verify uses the lock without the keys desired dropped, so a deleted list is not reported missing.

**Known limits**: every other index-addressed command (`trips rename`, `trips set-dates`, `sections rename|delete|move`, `places update|delete|move`, `lodging` edits, `debug cleanup-ai`) still relies on client-side checks only: it fetches, computes indexes and posts without a server-side compare, so an edit made in the app between its fetch and its post can make it touch a neighbouring item. `sections add-note` and the other inserts cannot destroy anything, but an insert computed from a stale fetch can land in the wrong place. Do not run these while someone is editing the trip, and re-fetch after each one.

## Maintainer guide

### Architecture

```text
.claude/skills/wanderlog/{bin/wlog.mjs,bin/args.mjs}
src/{commands.mjs,auth.mjs,browser.mjs,token-store.mjs,client.mjs,trips.mjs,
sections.mjs,places.mjs,budget.mjs,calendar.mjs,ics-generator.mjs,models.mjs,
ai-attribution.mjs,bulk.mjs,errors.mjs,output.mjs,sync.mjs,sync-cli.mjs}
test/                         # offline node:test suite and fixtures
```

`client.mjs` owns the authenticated HTTP client; command modules are network-isolated behind it. The Worker lives at `worker/` and serves `https://calendar.alanshum.dev/wanderlog`. It vendors copies of `src/ics-generator.mjs` and `src/models.mjs`; keep those copies synchronized with `worker/src/` when ICS behavior changes. `calendar.mjs` uses the Worker admin API for subscriptions, refresh, and previews.

### Where to add commands

Add flags in `bin/args.mjs`, route in `src/commands.mjs`, implement in the focused module, use typed errors from `src/errors.mjs`, and add offline sanitized fixtures/tests under `test/`. Mock `globalThis.fetch`; do not call live services. The date TODO above belongs here as the durable implementation record.

### Tests and migration relationship

```bash
node --test test/
node --test worker/test/
```

Fixtures must not contain real cookies, personal data, or real trip IDs except the explicitly documented Jeju sandbox ID. The external vault skill at `/Users/alanshum/Documents/dotfiles/external/obsidian-notes/.claude/skills/travel/wanderlog/` is now a thin trip-planning consumer of this README and the in-repo skill; update the CLI docs here first when behavior changes, then update only its judgment/workflow guidance as needed. It is not an independent mechanics contract.

## Exit codes

| Code | Meaning |
|---:|---|
| 0 | Success |
| 1 | General, validation, corrupt token, network, or API error |
| 2 | Usage error or unknown command/flag |
| 3 | Authentication required or expired |
| 4 | Resource not found |
| 5 | Confirmation required, or a `budget` / `sections update-note` guard refused the change before any write |
| 6 | `budget add`: an expense with the same owner tag and external id already exists |
| 7 | `budget`, `sections update-note`: post-write verification failed or the write outcome is uncertain; not retried. List before retrying |
| 8 | `budget update/remove`, `sections update-note`: the Budget or the section changed since the fetch and Wanderlog refused the batch; nothing written, safe to re-run (bounded) |

`wlog sync` has its own table (see “Trip-file sync”): 3 refused, 4 fetch or auth, 5 compare refused, 7 uncertain, 8 version changed, 10 unacknowledged drift.
