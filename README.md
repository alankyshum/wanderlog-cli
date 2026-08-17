# Wanderlog CLI

wlog manages Wanderlog trips, sections, and places, generates ICS calendars, and controls calendar subscriptions through a Worker admin API. It authenticates by capturing a cookie through Chrome/CDP in a temporary isolated profile that never touches the user's main Chrome profile; it runs on Node 22+ ESM with no package-local runtime dependencies.

<img width="1344" height="752" alt="file-e3b73864587e96c48c6b062cf16064ae" src="https://github.com/user-attachments/assets/222feadf-5454-4c40-8539-4df68b0b436a" />


## Install and authenticate

The chezmoi-managed install places this repository at `~/.local/share/wanderlog-cli-src/`, symlinks `~/.local/bin/wlog`, and stores the token at `~/.config/wanderlog/token.json` (directory `0700`, file `0600`).

```bash
wlog --version
wlog auth login
wlog auth status
```

`auth login` opens Chrome, Chromium, Brave, or Edge with a temporary isolated profile, waits for sign-in, and captures only the `connect.sid` cookie over CDP. It does not touch the user's normal browser profile. Use `--timeout 10m` or `--verbose` as needed. If no browser is available, use `wlog auth import-cookie --cookie 'connect.sid=...'`. A 401/403 or exit code 3 means re-run `wlog auth login`.

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

Sections have **no date field**. A `dayPlan` section has exactly the relevant shape `{id, heading, mode:"dayPlan", type:"normal", blocks:[]}`; `date`, `dayIndex`, and `startDate` are absent. Dates are purely positional: the k-th `dayPlan` section renders as `tripPlan.startDate + k days`. Renaming a dayPlan heading does not detach its date: the UI can show a date header with the theme as a subheading, and the sidebar can show `Mon 3/8: Drive Down the 5`.

A fresh trip ships with `Notes` (`textOnly`), `Places to visit` (`placeList`), an untitled `placeList`, and one untitled empty `dayPlan` section per trip day. Those untitled dayPlan sections are the dates. Never delete them. If `count(dayPlan sections) < trip day count`, the trip is broken and Wanderlog shows “Your itinerary is missing sections for the dates of your trip.”

The safe population flow is `sections list` → `sections rename <existing sectionId> "<Theme>"` in date order → `places enrich-add` into those same IDs. Use `sections add --mode dayPlan` only when the trip genuinely needs more days than its date range; usually the correct fix is `trips set-dates`. Keep unused date slots empty rather than adding filler.

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
- `check-status` reports actionable closed/invalid/error rows by default; `UNKNOWN` rows are hidden unless `--show-unknown`, and `OPERATIONAL` rows are counted but not listed.

See `.claude/skills/wanderlog/SKILL.md` for the full command table, flags, auth runbook, schemas, notes convention, check-status semantics, applyOps gotchas, and troubleshooting signatures.

## Maintainer guide

### Architecture

```text
.claude/skills/wanderlog/{bin/wlog.mjs,bin/args.mjs}
src/{commands.mjs,auth.mjs,browser.mjs,token-store.mjs,client.mjs,trips.mjs,
sections.mjs,places.mjs,calendar.mjs,ics-generator.mjs,models.mjs,
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
| 5 | Confirmation required |
