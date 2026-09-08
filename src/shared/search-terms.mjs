// Splitting a dashboard search box into terms.
//
// Two shapes go into the same input: free text ("your verification code") and
// lists of identifiers (MDNs, ICCIDs, SIM ids, rental ids). They need opposite
// treatment -- free text must stay one substring or body search breaks, while a
// list must become one term per entry.
//
// Commas, semicolons, newlines and tabs are unambiguous separators. Spaces are
// not, so they only split when EVERY whitespace-separated token looks like an
// identifier. That heuristic mirrors matchesSearch() in
// src/dashboard/public/index.html, which the Sims table already uses; this
// module exists so the Messages backend can apply the same rule.
//
// Pure functions only; no IO. Unit-tested directly (tests/search-terms.test.mjs).

// Optional leading +, then 5 or more digits. 5 is low enough to catch a short
// internal id and high enough that ordinary prose words never qualify.
const IDENTIFIER = /^\+?\d{5,}$/;

// Keep alphanumerics, whitespace, + and - : the characters that appear in the
// identifiers and free text we search on. Everything else is punctuation that
// would only ever produce a false negative against the stored value.
function sanitize(term) {
  return term.replace(/[^a-zA-Z0-9\s+\-]/g, '').trim();
}

/**
 * Split a raw search box value into search terms.
 *
 * @param {string} query raw input value
 * @param {number} max   cap on returned terms; the caller turns each term into
 *                       several PostgREST predicates, so this bounds URL length
 * @returns {string[]} terms, never null, possibly empty
 */
export function splitSearchTerms(query, max = 10) {
  const raw = String(query == null ? '' : query).trim();
  if (!raw) return [];

  const terms = raw.split(/[,;\r\n\t]+/).map(sanitize).filter(Boolean);

  // A mobile <input> converts pasted newlines to spaces, so a pasted column of
  // numbers arrives space-separated and would otherwise be one long term.
  const wsParts = raw.split(/[\s,;]+/).map(sanitize).filter(Boolean);
  if (wsParts.length > terms.length && wsParts.every((p) => IDENTIFIER.test(p))) {
    return wsParts.slice(0, max);
  }

  return terms.slice(0, max);
}
