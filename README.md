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

`wlog trips validate` may return `valid:true` for broken date layouts; it does not check date alignment. Assert that the dayPlan count equals the trip day count and verify rendered dates against the **original date-bound section IDs**. Never compute offsets over sections you just rearranged—that is circular.

### Repairing an already-broken trip

The UI's “Create the sections for me” button is client-side React behavior that auto-saves via `POST /api/tripPlans/<key>/applyOps`. It appends one operation per missing day, with this value:

```json
{"op":"insert","path":["sections",<idx>],"value":{"id":<9-digit int>,"heading":"","mode":"dayPlan","type":"normal","blocks":[]}}
```

The response is `{"success":true}`. After regeneration, rename the new sections in date order, move blocks into them with `places move`, then delete only stray non-date themed sections. Never delete the original date-bound sections. The CLI currently cannot detect or regenerate missing date sections. Durable TODO: implement `wlog trips validate --check-dates` (dayPlan count versus trip day count and anchored alignment reporting) and `wlog sections ensure-days <tripKey>` (append exactly the payload above, do not reorder/delete existing sections, re-fetch and verify).

## Safety and durable notes

- List trips and sections before mutation; fetch and validate after every write. `applyOps` can return `success:true` for an invalid/no-op or renderer-breaking write.
- Destructive commands require the exact `--confirm <id>` value. Never drive the browser or call raw APIs as a shortcut around the CLI workflow.
- Prefer Google-enriched POIs. Check `formatted_address`, especially for multi-branch chains, before accepting a result.
- AI-created/touched place titles use `🤵‍♂️ <Name>`. `enrich-add` prepends `**Plan**` only with `--duration`, always adds `**What**`, and adds `**Cost**` only with `--cost`, before user notes. Notes should describe durable essence, not “after lunch”, “on the way back”, dates, times, or driving order.
- Native lodging uses `lodging add`: a `type:"hotels"`, `mode:"placeList"`, `heading:"Hotels and lodging"` section with `type:"place"` blocks and `hotel:{checkIn,checkOut,confirmationNumber,travelerNames}`. It is not a `type:"hotel"` block; `lodging add-place` is the day-plan fallback.
- `sections add <tripKey> "..." --mode placeList` creates a normal list; `sections add-note <tripKey> <sectionId> --notes "..."` adds a text block to a normal day or list section.
- `sections update-note <tripKey> <sectionId> <blockIndex> --notes "..." --expected-notes "<current text>" --confirm <blockId>` replaces only an exact, unformatted note, checking its ID and old text and re-fetching afterward; formatted notes are refused.
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
- **Verification**: each mutation fetches the trip, computes the index from that fresh array, posts one op using the exact old object, re-fetches, and checks the target expense, every other expense, `payments` and the budget amount. A failed check or an uncertain write (network error or 5xx) exits 7 and is never retried: run `budget list` before deciding what to do. `--dry-run` prints the op without writing.

## Maintainer guide

### Architecture

```text
.claude/skills/wanderlog/{bin/wlog.mjs,bin/args.mjs}
src/{commands.mjs,auth.mjs,browser.mjs,token-store.mjs,client.mjs,trips.mjs,
sections.mjs,places.mjs,budget.mjs,calendar.mjs,ics-generator.mjs,models.mjs,
ai-attribution.mjs,bulk.mjs,errors.mjs,output.mjs}
test/                         # offline node:test suite and fixtures
```

`client.mjs` owns the authenticated HTTP client; command modules are network-isolated behind it. The Worker lives at `public/workers/wanderlog-calendar/` and serves `https://calendar.alanshum.dev/wanderlog`. It vendors copies of `src/ics-generator.mjs` and `src/models.mjs`; keep those copies synchronized with `worker/src/` when ICS behavior changes. `calendar.mjs` uses the Worker admin API for subscriptions, refresh, and previews.

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
| 5 | Confirmation required, or a `budget` guard refused the change |
| 6 | `budget add`: an expense with the same owner tag and external id already exists |
| 7 | `budget`: post-write verification failed or the write outcome is uncertain; not retried |
