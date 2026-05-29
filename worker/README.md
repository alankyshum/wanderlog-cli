# Wanderlog Calendar Worker

Serves a stable private-owner ICS feed for subscribed Wanderlog trips at:

- `https://calendar.alanshum.org/wanderlog`
- `https://calendar.alanshum.org/wanderlog.ics`

The public URL never includes a `planId`; subscriptions are managed through the admin API and stored in Cloudflare KV.

## Setup

Create KV and replace the placeholder IDs in `wrangler.toml`:

```sh
wrangler kv:namespace create WANDERLOG_KV
wrangler kv:namespace create WANDERLOG_KV --preview
```

Set secrets:

```sh
wrangler secret put ADMIN_TOKEN
wrangler secret put WANDERLOG_COOKIE
```

`WANDERLOG_COOKIE` is the full Cookie header value, e.g. `connect.sid=s:...`.

Deploy:

```sh
wrangler deploy
```

## Endpoints

Public:

- `GET /wanderlog` — ICS feed
- `GET /wanderlog.ics` — ICS feed alias
- `HEAD /wanderlog.ics` — headers-only calendar check
- `GET /wanderlog/api/v1/health` — `{ "status": "ok" }`

Admin (`Authorization: Bearer <ADMIN_TOKEN>`):

- `GET /wanderlog/api/v1/subscriptions`
- `POST /wanderlog/api/v1/subscriptions` with `{ "planId": "...", "title": "...", "alias": "...", "timezone": "..." }`
- `PATCH /wanderlog/api/v1/subscriptions/:planId`
- `DELETE /wanderlog/api/v1/subscriptions/:planId`
- `POST /wanderlog/api/v1/refresh`
- `GET /wanderlog/api/v1/preview.ics?planId=...`

## CLI subscription

```sh
WANDERLOG_CALENDAR_ADMIN_TOKEN=... \
  wlog calendar subscribe lpwekdgnmmcqjkjo --alias Jeju --timezone Asia/Seoul
```

Then subscribe calendar apps to:

```text
https://calendar.alanshum.org/wanderlog
```

## Calendar app setup

- **Apple Calendar:** File → New Calendar Subscription → paste the URL → choose refresh interval.
- **Google Calendar:** Other calendars → From URL → paste the URL.
- **Outlook:** Add calendar → Subscribe from web / Internet calendar → paste the URL.

## Vendored code sync note

Worker deploys cannot import files outside this directory. These files are vendored and must be kept in sync with the CLI copies:

- `src/ics-generator.mjs` from `.claude/skills/wanderlog/src/ics-generator.mjs`
- `src/models.mjs` from `.claude/skills/wanderlog/src/models.mjs`

Do not log `ADMIN_TOKEN`, `WANDERLOG_COOKIE`, or request Authorization headers.
