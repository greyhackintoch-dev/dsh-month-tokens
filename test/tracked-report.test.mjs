/**
 * Checks for the standalone report tool.
 *
 * The store reader is small and that is exactly why it is pinned: a reader
 * that fails to recognise a spelling returns `undefined`, and the caller then
 * silently reports a month of zero. The flow spelling (`refs: { NAME: value }`)
 * is the one that matters here — it is what the local credential store
 * actually uses, and a reader that only understood the block spelling is how
 * a diagnostic once printed a live key into a transcript instead of hashing it.
 *
 * Usage: node test/tracked-report.test.mjs
 */
import assert from 'node:assert/strict';
import { credentialFromStore } from '../tools/tracked-report.mjs';

// The spelling the store actually uses.
assert.equal(
    credentialFromStore('refs: { DEEPSEEK_API_KEY: sk-not-a-real-key-0000000000000000 }', 'DEEPSEEK_API_KEY'),
    'sk-not-a-real-key-0000000000000000',
);
// …and the block spelling, which a hand-edited store may use.
assert.equal(
    credentialFromStore('version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-block\n', 'DEEPSEEK_API_KEY'),
    'sk-block',
);
// One ref among several, in either spelling.
assert.equal(credentialFromStore('refs: { A_KEY: aaa, DEEPSEEK_API_KEY: sk-mid, B_KEY: bbb }', 'DEEPSEEK_API_KEY'), 'sk-mid');
assert.equal(credentialFromStore('refs: { DEEPSEEK_API_KEY: sk-first, B_KEY: bbb }', 'DEEPSEEK_API_KEY'), 'sk-first');
assert.equal(credentialFromStore('refs: { A_KEY: aaa, DEEPSEEK_API_KEY: sk-last }', 'DEEPSEEK_API_KEY'), 'sk-last');
assert.equal(credentialFromStore('refs:\n  A_KEY: aaa\n  DEEPSEEK_API_KEY: sk-second\n  B_KEY: bbb\n', 'DEEPSEEK_API_KEY'), 'sk-second');

// A longer name that merely starts the same must not match: reading the wrong
// credential would attribute another key's usage to this one.
assert.equal(credentialFromStore('refs: { DEEPSEEK_API_KEY_BACKUP: sk-other }', 'DEEPSEEK_API_KEY'), undefined);
assert.equal(credentialFromStore('refs:\n  DEEPSEEK_API_KEY_OLD: sk-other\n', 'DEEPSEEK_API_KEY'), undefined);

// A ref whose name contains regex metacharacters is matched literally.
assert.equal(credentialFromStore('refs: { A.B: x, DEEPSEEK.API: sk-dotted }', 'DEEPSEEK.API'), 'sk-dotted');
assert.equal(credentialFromStore('refs: { AXB: x }', 'A.B'), undefined);

// Absence is `undefined`, never a fabricated value.
assert.equal(credentialFromStore('refs: { OTHER: x }', 'DEEPSEEK_API_KEY'), undefined);
assert.equal(credentialFromStore('', 'DEEPSEEK_API_KEY'), undefined);
assert.equal(credentialFromStore('refs: {}\n', 'DEEPSEEK_API_KEY'), undefined);

console.log('tracked-report: ok');
