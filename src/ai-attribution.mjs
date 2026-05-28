import { createHash, randomBytes } from 'node:crypto';

const AI_EMOJI_PREFIX = '🤵‍♂️';
const LEGACY_AI_PREFIX_RE = /^\[🤵‍♂️ - ([a-f0-9]{8,})\]\s*(.*)$/u;
const NEW_AI_PREFIX_RE = /^🤵‍♂️\s+(.+)$/u;

export function generateAiHash(input) {
  const seed = input || randomBytes(8).toString('hex');
  return createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
}

export function formatAiPrefix(hash) {
  void hash;
  return AI_EMOJI_PREFIX;
}

export function addAiPrefix(name, hash) {
  void hash;
  if (parseAiPrefix(name)) return name;
  return `${formatAiPrefix()} ${String(name ?? '').trim()}`;
}

export function parseAiPrefix(text) {
  if (typeof text !== 'string') return null;
  const legacyMatch = text.match(LEGACY_AI_PREFIX_RE);
  if (legacyMatch) return { hash: legacyMatch[1], baseName: legacyMatch[2], format: 'legacy' };

  const newMatch = text.match(NEW_AI_PREFIX_RE);
  if (!newMatch) return null;
  return { hash: null, baseName: newMatch[1], format: 'new' };
}

export function preserveAiPrefix(oldName, newName) {
  const parsed = parseAiPrefix(oldName) ?? parseAiPrefix(newName);
  const stripped = parseAiPrefix(newName)?.baseName ?? newName;
  void parsed;
  return addAiPrefix(stripped);
}
