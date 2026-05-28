import { createHash, randomBytes } from 'node:crypto';

const AI_EMOJI_PREFIX = '🤵‍♂️';
const LEGACY_AI_PREFIX_RE = /^\[🤵‍♂️ - ([a-f0-9]{8,})\]\s*(.*)$/u;
const NEW_AI_PREFIX_RE = /^🤵‍♂️\s+(.+)$/u;
const HASH_LINE_RE = /^\[([a-f0-9]{8,})\](?:\n|$)/u;

export function generateAiHash(input) {
  const seed = input || randomBytes(8).toString('hex');
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
}

export function formatAiPrefix(hash) {
  return AI_EMOJI_PREFIX;
}

export function addAiPrefix(name, hash) {
  if (parseAiPrefix(name)) return name;
  return `${formatAiPrefix(hash)} ${stripHashFromName(name)}`;
}

export function parseAiPrefix(text) {
  if (typeof text !== 'string') return null;
  const legacyMatch = text.match(LEGACY_AI_PREFIX_RE);
  if (legacyMatch) return { hash: legacyMatch[1], baseName: legacyMatch[2], format: 'legacy' };

  const lines = text.split('\n');
  const newMatch = lines[0]?.match(NEW_AI_PREFIX_RE);
  if (!newMatch) return null;
  const baseName = stripHashFromName(newMatch[1]);
  const hash = lines.slice(1).join('\n').match(HASH_LINE_RE)?.[1] ?? null;
  return { hash, baseName, format: 'new' };
}

export function preserveAiPrefix(oldName, newName) {
  const parsed = parseAiPrefix(oldName) ?? parseAiPrefix(newName);
  const stripped = parseAiPrefix(newName)?.baseName ?? newName;
  const hash = parsed?.hash ?? generateAiHash(`${oldName ?? ''}:${newName ?? ''}`);
  return addAiPrefix(stripped, hash);
}

export function buildAiTextOps(hash, userNotes = '') {
  return [{ insert: `[${hash}]\n${userNotes ? `${userNotes}\n` : ''}` }];
}

function stripHashFromName(name) {
  return String(name ?? '').replace(HASH_LINE_RE, '').trim();
}
