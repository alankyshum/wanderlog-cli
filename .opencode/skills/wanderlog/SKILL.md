# Skill: wanderlog

Manage Wanderlog trips, sections, place blocks, and the stable calendar feed with the in-repo `wlog` CLI.

## Installed CLI

The chezmoi-managed install pulls this repo into `~/.local/share/wanderlog-cli-src/` and symlinks `~/.local/bin/wlog`.

```bash
wlog --version
wlog auth status
```

Auth is stored at `~/.config/wanderlog/token.json`; re-run `wlog auth login` on 401/403.

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
- Optional: `--start HH:MM`, `--end HH:MM`, `--notes "..."`, `--no-ai`, `--google-key <key>`
- `--google-key` defaults to `$GOOGLE_MAPS_API_KEY`.

Implementation notes:

- Uses Google Places v1 Text Search + Place Details.
- Maps v1 details into Wanderlog's legacy `place.{name, place_id, geometry.location, formatted_address, vicinity, rating, user_ratings_total, website, address_components, opening_hours, types, url, business_status, photo_urls}` shape.
- Inserts through Wanderlog `/applyOps` via `src/client.mjs`, then re-fetches the trip and verifies the target section block count incremented by one.
- `photo_urls` is intentionally `[]` until v1 photo media URL support is added.

## AI attribution format

New AI-created/touched place titles use:

```text
🤵‍♂️ <Name>
```

The attribution hash belongs in the first note/text op line:

```js
text.ops = [{ insert: '[<hash>]\n' + (userNotes ? userNotes + '\n' : '') }]
```

Parsers must remain backward-compatible with legacy names:

```text
[🤵‍♂️ - <hash>] <Name>
```

## Safety rules

- List sections before mutating: `wlog sections list <tripKey>`.
- Never run live `enrich-add` against a populated production trip unless the user explicitly asks; it can create duplicates.
- Do not expose cookies, token contents, or Google API keys.
- Use `node --test test/` and `node --test worker/test/` before shipping CLI changes.
