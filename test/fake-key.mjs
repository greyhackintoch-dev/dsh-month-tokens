/**
 * Key-shaped fixtures, composed at runtime.
 *
 * A fixture key has to look like the real thing — `sk-` plus 32 characters —
 * for the fingerprint and matching code to be exercised honestly. Written as
 * a string literal it is also indistinguishable from a live credential to
 * secret scanners, and GitHub's push protection rejects the entire push on
 * sight: a false positive that costs a history rewrite to clear, on a
 * repository whose whole subject is key handling.
 *
 * Composing it here keeps the fixtures realistic and the repository free of
 * anything shaped like a secret, which is also the honest signal — nothing in
 * this suite should ever need to name a real key.
 *
 * @module test/fake-key
 */

/**
 * One distinct, non-secret key-shaped placeholder.
 * @param seed - a small integer; distinct seeds give distinct keys.
 * @returns a 35-character `sk-`-prefixed string.
 */
export function fakeKey(seed) {
  return `sk-${String(seed).padStart(32, '0')}`;
}
