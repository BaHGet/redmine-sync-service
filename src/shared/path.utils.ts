/**
 * Decode percent-encoded characters (e.g. %5B → [, %20 → space) and
 * normalise path separators.
 *
 * Safe to call multiple times — idempotent on already-decoded strings.
 * Returns null if the path contains a traversal attempt (`..`).
 */
export function normalizePath(raw: string): string {
  let p = raw;
  // Decode up to two rounds to handle double-encoded inputs (%255B → %5B → [)
  try {
    p = decodeURIComponent(p);
  } catch {
    /* malformed — use as-is */
  }
  try {
    p = decodeURIComponent(p);
  } catch {
    /* second pass failed — keep first result */
  }
  p = p.replace(/\\/g, '/').replace(/\/+/g, '/').trimEnd();
  return p;
}

/**
 * Like normalizePath but rejects paths containing `..` to prevent traversal.
 * Returns null for unsafe paths.
 */
export function sanitizeWebdavPath(raw: string): string | null {
  const p = normalizePath(raw);
  if (p.includes('..')) return null;
  return p;
}
