// Resolve a human-friendly title for a note whose first line is *just* a URL,
// using OpenGraph/Twitter metadata or the document <title>. Worker-only: it
// needs `fetch` + KV, so the CLI path leaves URL-only notes as-is. Results are
// cached per-URL in KV (positive long, negative short) to keep refreshes cheap.

const URL_LINE_RE = /^https?:\/\/\S+$/i;
const CACHE_PREFIX = 'linktitle:';
const POS_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const NEG_TTL_SECONDS = 60 * 60 * 6;      // 6 hours
const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 200000;
const MAX_TITLE_WORDS = 12;

// Return a URL to resolve ONLY when the note is URL-only (no human line to use).
// If the note has any non-URL text line, deriveSummary uses that instead and we
// skip the network fetch entirely.
export function noteUrl(notes) {
  const lines = String(notes ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
  if (lines.length === 0) return null;
  const url = lines.find(line => URL_LINE_RE.test(line));
  if (!url) return null;
  const hasText = lines.some(line => !URL_LINE_RE.test(line));
  return hasText ? null : url;
}

function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function extractTitleFromHtml(html) {
  if (!html) return null;
  const head = String(html).slice(0, MAX_HTML_BYTES);
  const pick = re => {
    const m = re.exec(head);
    return m ? decodeEntities(m[1]) : null;
  };
  const title =
    pick(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
    pick(/<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i) ||
    pick(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!title) return null;
  const collapsed = title.replace(/\s+/g, ' ').trim();
  return collapsed || null;
}

export function clampWords(value, max = MAX_TITLE_WORDS) {
  const words = String(value).split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  return words.length > max ? words.slice(0, max).join(' ') + '\u2026' : words.join(' ');
}

async function resolveTitle(env, url) {
  const kv = env?.WANDERLOG_KV;
  const key = CACHE_PREFIX + url;
  if (kv) {
    const cached = await kv.get(key);
    if (cached != null) return cached || null; // '' == cached negative
  }
  let resolved = null;
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'wanderlog-calendar/1.0 (+https://calendar.alanshum.org)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && (contentType.includes('html') || contentType === '')) {
      const html = await res.text();
      resolved = extractTitleFromHtml(html);
    }
  } catch {
    resolved = null;
  }
  const value = resolved ? clampWords(resolved) : '';
  if (kv) {
    try {
      await kv.put(key, value, { expirationTtl: value ? POS_TTL_SECONDS : NEG_TTL_SECONDS });
    } catch {
      /* cache write best-effort */
    }
  }
  return value || null;
}

// Walk normalized trips; for any block whose note is a bare URL, set
// block.titleOverride from the link's OG/title metadata. Mutates trips in place.
export async function enrichTripsWithLinkTitles(env, trips) {
  const tasks = [];
  for (const trip of trips ?? []) {
    for (const section of trip?.sections ?? []) {
      for (const block of section?.blocks ?? []) {
        const url = noteUrl(block?.notes);
        if (!url) continue;
        tasks.push(resolveTitle(env, url).then(title => {
          if (title) block.titleOverride = title;
        }));
      }
    }
  }
  await Promise.allSettled(tasks);
  return trips;
}
