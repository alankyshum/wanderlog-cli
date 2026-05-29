# Skill: wanderlog

Manage Wanderlog trips, sections, place blocks, and the stable calendar feed with the in-repo `wlog` CLI.

## Installed CLI

The chezmoi-managed install pulls this repo into `~/.local/share/wanderlog-cli-src/` and symlinks `~/.local/bin/wlog`.

```bash
wlog --version
wlog auth status
```

Auth is stored at `~/.config/wanderlog/token.json`; re-run `wlog auth login` on 401/403.

## Command quick reference

| Command | Purpose |
| --- | --- |
| `wlog auth login` | Browser-based login that stores `connect.sid`. |
| `wlog trips list` / `wlog trips get <tripKey>` | Find and inspect trips. |
| `wlog sections list <tripKey>` | Find section ids before mutations. |
| `wlog places enrich-add <tripKey> <sectionId> --query "..."` | Add a Google-enriched place block. |
| `wlog places check-status <tripKey> [--json] [--show-unknown]` | Sweep itinerary places, hotels, flights, and rental cars for non-operational Google business statuses and stale Google IDs. |
| `wlog calendar subscribe <tripKey>` | Subscribe a trip to the stable calendar feed. |

## Browser auth login

`wlog auth login` is browser-based and requires an installed compatible browser (Chrome first, then Chromium, Brave, or Microsoft Edge). It launches a temporary isolated browser profile, so it never touches the user's normal cookies/history or existing Chrome windows.

Screenshot-style runbook:

```text
$ wlog auth login
Opening Chrome to https://wanderlog.com/login ...
Waiting for you to sign in (timeout: 5 min) ...

[Chrome opens Wanderlog login]
1. Sign in normally in the browser window.
2. Let Wanderlog redirect away from /login.
3. The CLI auto-detects the redirect; do not copy/paste cookies or press Enter.

✓ Detected sign-in
✓ Cookie captured (connect.sid, expires YYYY-MM-DD)
✓ Wrote /Users/alanshum/.config/wanderlog/token.json
```

Then verify:

```bash
wlog auth status
# authenticated: true
# userId: <id if Wanderlog exposes it>
```

Flags:

- `--timeout 10m` extends the default 5-minute sign-in window.
- `--verbose` prints Chrome spawn, CDP connect, and frame navigation details.

Fallback/error handling:

- If no compatible browser is installed, the CLI says: `No compatible browser found. Install Google Chrome, Chromium, Brave, or Microsoft Edge, then run wlog auth login again.`
- Manual fallback remains `wlog auth import-cookie --cookie 'connect.sid=...'`; do not remove or break it.

## Places enrich-add

Add a Google-enriched place block without manually copying coordinates/address:

```bash
export GOOGLE_MAPS_API_KEY="$(op item get eryf3fv6lhqyjqiq7qqyrnjt7y --vault Env-Secrets --reveal --format json | jq -r '.fields[] | select(.label=="credential" or .purpose=="PASSWORD") | .value')"
wlog places enrich-add <tripKey> <sectionId> \
  --query "Handam Coastal Walk Aewol Jeju" \
  --start 10:30 --end 12:30
```

Flags:

- Required: `--query "NAME [Jeju]"`
- Optional: `--duration <text>`, `--cost <text>`, `--start HH:MM`, `--end HH:MM`, `--notes "..."`, `--no-ai`, `--google-key <key>`
- `--google-key` defaults to `$GOOGLE_MAPS_API_KEY`.
- `--duration` is free-form (`30 min`, `1–1.5 h`, `2.5 h total`) and controls the optional Plan header. If omitted, the CLI omits the Plan line rather than fabricating one.

Implementation notes:

- Uses Google Places v1 Text Search + Place Details.
- Maps v1 details into Wanderlog's legacy `place.{name, place_id, geometry.location, formatted_address, vicinity, rating, user_ratings_total, website, address_components, opening_hours, types, url, business_status, photo_urls}` shape.
- Inserts through Wanderlog `/applyOps` via `src/client.mjs`, then re-fetches the trip and verifies the target section block count incremented by one.
- `--with-photos` expands up to three Google Places v1 photo media URLs into `photo_urls`.

## Places check-status

Before a trip, and after any reported closures, agents should sweep for replacements:

```bash
wlog places check-status <tripKey> --json
# Add --show-unknown for a full audit that includes places without Google businessStatus/business profiles.
```

This reports only actionable rows by default: `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`, `PLACE_ID_INVALID`, and `ERR_*`, including regular place blocks plus hotel, flight airport, and rental-car pickup/dropoff places. `OPERATIONAL` rows are never listed but are counted in the summary.

`UNKNOWN` means Google returned 200 OK without `businessStatus` (often raw addresses, non-business attractions, rentals, or places with no business profile). These rows are hidden by default; pass `--show-unknown` when you need a full audit.

`PLACE_ID_INVALID` means Google returned `NOT_FOUND` for a retired/migrated Place ID. Fix by re-enriching that block: re-search the place by name, then update/replace the stale block with the current Google place details.

`--google-key` defaults to `$GOOGLE_MAPS_API_KEY`.

## AI attribution format

AI-created/touched place titles use:

```text
🤵‍♂️ <Name>
```

Plain `places add` notes are only the user's `--notes` payload plus Wanderlog's trailing newline, or `[{ insert: '\n' }]` when no notes are provided. `places enrich-add` auto-bakes the convention headers below before user notes.

### Notes convention — write for durability, not sequence

Place notes capture the place's **durable essence**: what it IS, why it earned its slot, and the **signature thing to look for** that creates a memory. Examples: "Udo peanut latte at Klein Blue", "tangerine hand-cream at Innisfree", "천년비자 Sacred Tree at Bijarim".

For `wlog places enrich-add`, the CLI prepends these headers before user `--notes`:

```text
**Plan ~<duration>.** 
**What:** <Google displayName> — <human Google type>.
**Cost:** <cost>.
<user --notes here>
```

- `**Plan**` is included only when `--duration <text>` is passed; no duration means no Plan line.
- `**What**` is always included from Google Places enrichment. Non-Latin/non-Chinese display names get an English fallback in parentheses when Google provides one; otherwise the line includes `<!-- TODO: add English name -->`.
- `**Cost:** <amount + payment method + notes>.` captures the single most useful budget number for the visit: entry fee, ticket price, parking, fuel top-up, `Free`, or a paid-elsewhere booking reference. Include card/cash and any cash-backup advice on the same durable line so it survives reordering.
- `**Cost:** ₩3,000 adult / ₩1,500 child entry + ₩3,000 flat parking. Card OK; ₩5–10k cash backup.`
- `**Cost:** Booking ref ABC123 paid (US$135.45). No additional unless damage/loss.`

Example:

```bash
wlog places enrich-add <tripKey> <sectionId> \
  --query "협재해수욕장 Jeju" \
  --duration "1 h" \
  --cost "₩3,000 adult / ₩1,500 child entry + ₩3,000 flat parking. Card OK; ₩5–10k cash backup" \
  --notes "Wide white-sand beach with Biyangdo island views."
# Notes become:
# **Plan ~1 h.** 
# **What:** 협재해수욕장 (Hyeopjae Beach) — tourist attraction.
# **Cost:** ₩3,000 adult / ₩1,500 child entry + ₩3,000 flat parking. Card OK; ₩5–10k cash backup.
# Wide white-sand beach with Biyangdo island views.
```

NEVER write order- or sequence-dependent content. It goes stale the instant the user rearranges blocks in the Wanderlog UI.

- ❌ "Drive 25 min from Aewol"
- ❌ "On the way back"
- ❌ "After lunch"
- ❌ "Next to O'sulloc"
- ❌ specific dates / times / day names
- ❌ "Replaces X" (history footnote; fine when truly durable, but skip if you can)
- ✅ Karlam dossier hooks: "Karlam pick — sea + concrete brutalism"
- ✅ Opening hours, entry fee, booking refs, parking info
- ✅ Signature dish / view / artifact

## Safety rules

- List sections before mutating: `wlog sections list <tripKey>`.
- Run `wlog places check-status <tripKey> --json` before a trip and after any reported closures, then use the result to propose replacements.
- Never run live `enrich-add` against a populated production trip unless the user explicitly asks; it can create duplicates.
- Do not expose cookies, token contents, or Google API keys.
- Use `node --test test/` and `node --test worker/test/` before shipping CLI changes.
