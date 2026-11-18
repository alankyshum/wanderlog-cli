# Calendar events from the trip files

The vault's `trip_calendar.py TRIP --events-json F` writes this document. `wlog calendar render --events F` prints its ICS; `wlog calendar publish <trip> --events F [--json]` stores it in the Worker and verifies the feed. The validator and serialiser are `worker/src/file-events.mjs`, used by both the CLI and the Worker.

## Document

```json
{
  "schema": "wanderlog-calendar-events/1",
  "trip_key": "<Wanderlog trip key>",
  "title": "optional trip title (used only when publish creates the subscription)",
  "events": [
    {
      "uid": "tf-<trip_key>-day-2026-12-03",
      "title": "Day 1 — Old town",
      "all_day": true,
      "date": "2026-12-03",
      "description": "1. Cafe\n2. Coastal walk"
    },
    {
      "uid": "tf-<trip_key>-<entry id>",
      "title": "Breakfast at the cafe",
      "all_day": false,
      "start": "2026-12-03T09:00",
      "end": "2026-12-03T10:00",
      "tz": "Asia/Seoul",
      "location": { "name": "Cafe", "address": "1 Test St", "lat": 33.5, "lng": 126.5 },
      "description": "optional free text"
    }
  ]
}
```

Rules (unknown keys are rejected at every level):

| Field | Rule |
|---|---|
| `schema` | exactly `wanderlog-calendar-events/1` |
| `trip_key` | `[A-Za-z0-9_-]{1,100}`; must equal the `:planId` of the PUT and the trip given to `publish` |
| `title` | optional string, at most 300 characters |
| `events` | array, at most 1000; serialised in the given order |
| `uid` | `tf-<trip_key>-<id>`, `id` in `[A-Za-z0-9._-]`, at most 200 characters, unique. The serialiser appends `@wanderlog-calendar`. Keep it stable: a changed UID is a new event for subscribers |
| `title` (event) | non-empty string, at most 300 characters |
| `all_day: true` | needs `date` (`YYYY-MM-DD`); `start`, `end`, `tz` are not allowed. ICS: `DTSTART;VALUE=DATE` and an exclusive `DTEND` on the next day |
| `all_day: false` | needs `start` and `end` (`YYYY-MM-DDTHH:MM`, wall-clock time in `tz`), `end` after `start` (may be a later date), and `tz` (IANA name). `date` is not allowed. ICS: `DTSTART;TZID=<tz>` / `DTEND;TZID=<tz>` |
| `location` | optional object or `null`: `name`, `address` (strings, at most 500), `lat`/`lng` (numbers, both or neither). ICS: `LOCATION:` name and address joined by `, `; `GEO:` from lat/lng |
| `description` | optional string or `null`, at most 8000 characters |

Every event also gets `URL:https://wanderlog.com/plan/<trip_key>`. The whole PUT body is capped at 256 KiB.

## Worker

- `PUT /wanderlog/api/v1/subscriptions/:planId/events` (admin bearer token) validates the body, stores it in KV `trip:<planId>:events`, creates the subscription if needed and sets `source: 'file'`, bumps the subscription version and drops the cached feed. Responses: 200 `{ planId, source, events, sha256, version }` (`sha256` of the stored canonical JSON); 400 `{ error, details[] }`; 401; 413.
- The feed serves a `source: 'file'` subscription from that KV document and never fetches Wanderlog for it. A file subscription without a stored document contributes no events and is reported in `refresh` failures. Other subscriptions are unchanged.
- `DELETE /subscriptions/:planId` also deletes the stored events.

## CLI

- `render` validates locally (exit 2 on an invalid file) and prints the ICS; `--json` returns `{ ics }`.
- `publish` resolves `<trip>` against the subscription list (plan id, alias or title; no Wanderlog request), requires it to equal `trip_key`, PUTs, then reads the public feed. This trip's VEVENTs in the feed must equal the local render with the `DTSTAMP` lines removed; otherwise it exits 7 (published, not verified). Needs `WANDERLOG_CALENDAR_ADMIN_TOKEN`; `WANDERLOG_CALENDAR_URL` overrides the Worker base URL.
