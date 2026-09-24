/**
 * Identity checks for dsh-month-tokens.
 *
 * The fingerprint is the one value that has to agree across machines that
 * never talk to each other, so its derivation is pinned here: the same key
 * must produce the same bucket on every platform, and an unusable key must be
 * *reported* rather than silently collapsing into a zero.
 *
 * No DSH boot, no network, no dependencies.
 *
 * Usage: node test/identity.test.mjs
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    FINGERPRINT_DOMAIN,
    fingerprintOfKey,
    matchOpencodeKey,
    matchTrackedKey,
    normalizeApiKey,
    normalizeTrackKeys,
    parseOpencodeAuthKeys,
    providerFromRef,
    resolveTrackedKeys,
    shortFingerprint,
} from '../lib/identity.js';

// Shaped like a real DeepSeek key (`sk-` + 32) but not one.
const KEY_A = 'sk-00000000000000000000000000000001';
const KEY_B = 'sk-00000000000000000000000000000002';
const keyA = fingerprintOfKey(KEY_A).fingerprint;

// ── the fingerprint is stable and key-only ──────────────────────────────────

assert.deepEqual(fingerprintOfKey(KEY_A), fingerprintOfKey(KEY_A), 'the same key must fingerprint identically');
assert.notEqual(
    fingerprintOfKey(KEY_A).fingerprint,
    fingerprintOfKey(KEY_B).fingerprint,
    'different keys must not share a bucket',
);

// Padded input and its trimmed form are the same credential. A trailing
// newline from a file-backed store must not open a second bucket.
assert.deepEqual(fingerprintOfKey(`  ${KEY_A}\n`), fingerprintOfKey(KEY_A), 'surrounding whitespace must not change the bucket');

// Domain separation: the fingerprint is not the bare sha256 of the key, so a
// hash published by some other tool cannot be replayed as a bucket id here.
assert.notEqual(
    fingerprintOfKey(KEY_A).fingerprint,
    createHash('sha256').update(KEY_A).digest('hex'),
    'the fingerprint must be domain-separated',
);
assert.equal(
    fingerprintOfKey(KEY_A).fingerprint,
    createHash('sha256').update(FINGERPRINT_DOMAIN).update('\0').update(KEY_A).digest('hex'),
    'the derivation is part of the contract, not an implementation detail',
);

// The key itself must never appear in what we hand out.
assert.equal(JSON.stringify(fingerprintOfKey(KEY_A)).includes(KEY_A), false, 'the raw key must not survive into the result');

// ── unusable keys are reported, never zeroed ────────────────────────────────

assert.deepEqual(normalizeApiKey('   '), { ok: false, reason: 'empty' });
assert.deepEqual(normalizeApiKey(''), { ok: false, reason: 'empty' });
assert.deepEqual(normalizeApiKey(undefined), { ok: false, reason: 'absent' });
assert.deepEqual(normalizeApiKey(42), { ok: false, reason: 'absent' });
// A key with an interior space or a non-ASCII byte cannot reach any provider,
// so it is a configuration defect rather than a smaller month.
assert.deepEqual(normalizeApiKey('sk-a b'), { ok: false, reason: 'illegalCharacters' });
assert.deepEqual(normalizeApiKey('sk-中文'), { ok: false, reason: 'illegalCharacters' });
assert.equal(fingerprintOfKey('').ok, false, 'an empty key yields a verdict, not a fingerprint');

// ── display form ────────────────────────────────────────────────────────────

assert.equal(shortFingerprint(fingerprintOfKey(KEY_A).fingerprint).length, 8);
assert.equal(shortFingerprint(undefined), '');
assert.equal(shortFingerprint(null), '');

// ── config normalization ────────────────────────────────────────────────────

assert.deepEqual(
    normalizeTrackKeys(['DEEPSEEK_API_KEY']),
    [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek', providers: ['deepseek'], providerPatterns: [] }],
    'a bare ref derives its provider from the conventional name',
);
assert.deepEqual(
    normalizeTrackKeys([{ ref: 'MY_CORP_KEY', provider: 'deepseek' }]),
    [{ ref: 'MY_CORP_KEY', provider: 'deepseek', providers: ['deepseek'], providerPatterns: [] }],
    'an explicit provider wins over the naming convention',
);
// The multi-route form is what the measured logs require: one key reached
// through routes the shipped adapter and other plugins each registered.
assert.deepEqual(
    normalizeTrackKeys([{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official', 'vision-toolkit-deepseek-official'] }]),
    [{
        ref: 'DEEPSEEK_API_KEY',
        provider: 'deepseek-official',
        providers: ['deepseek-official', 'vision-toolkit-deepseek-official'],
        providerPatterns: [],
    }],
    'a key claims every route it owns, in declaration order',
);
assert.deepEqual(
    normalizeTrackKeys([{ ref: 'K', provider: 'a', providers: ['b', 'a'] }]),
    [{ ref: 'K', provider: 'b', providers: ['b', 'a'], providerPatterns: [] }],
    'the providers list leads, and a repeated route appears once',
);
assert.deepEqual(
    normalizeTrackKeys([{ ref: 'K', providers: ['a'], providerPatterns: ['^vision-toolkit-'] }]),
    [{ ref: 'K', provider: 'a', providers: ['a'], providerPatterns: ['^vision-toolkit-'] }],
    'patterns are carried through as written',
);
assert.deepEqual(
    normalizeTrackKeys(['A_KEY', 'A_KEY', { ref: 'A_KEY' }]),
    [{ ref: 'A_KEY', provider: 'a', providers: ['a'], providerPatterns: [] }],
    'duplicate refs collapse to one target',
);
assert.deepEqual(normalizeTrackKeys(undefined), []);
assert.deepEqual(normalizeTrackKeys('DEEPSEEK_API_KEY'), [], 'a bare string is not a list of refs');
assert.deepEqual(normalizeTrackKeys([{ provider: 'deepseek' }]), [], 'a target without a ref is not a target');
assert.deepEqual(normalizeTrackKeys([null, 7]), []);

assert.equal(providerFromRef('DEEPSEEK_API_KEY'), 'deepseek');
assert.equal(providerFromRef('OPENAI_API_KEY'), 'openai');
assert.equal(providerFromRef('ANTHROPIC_KEY'), 'anthropic');
assert.equal(providerFromRef('pi-ai'), 'pi-ai', 'a ref that follows no convention is passed through, not mangled');

// ── route ownership ─────────────────────────────────────────────────────────

{
    const keys = [{
        ref: 'DEEPSEEK_API_KEY',
        provider: 'deepseek-official',
        providers: ['deepseek-official'],
        patterns: [/^vision-toolkit-deepseek-/u],
        fingerprint: keyA,
    }];
    assert.equal(matchTrackedKey(keys, 'deepseek-official')?.ref, 'DEEPSEEK_API_KEY');
    assert.equal(matchTrackedKey(keys, 'vision-toolkit-deepseek-official')?.ref, 'DEEPSEEK_API_KEY', 'a pattern catches a route the config has not learned yet');
    assert.equal(matchTrackedKey(keys, 'vision-toolkit-deepseek-official-vision')?.ref, 'DEEPSEEK_API_KEY');
    // An unrelated provider belongs to nobody, and must not be folded in.
    assert.equal(matchTrackedKey(keys, 'openrouter'), undefined);
    assert.equal(matchTrackedKey(keys, ''), undefined);
    assert.equal(matchTrackedKey(keys, undefined), undefined);
    assert.equal(matchTrackedKey([], 'deepseek-official'), undefined);
}

// Explicit route names are consulted before patterns, so a broad pattern
// cannot steal a route another key names outright.
{
    const keys = [
        { ref: 'PATTERN_KEY', provider: 'x', providers: [], patterns: [/deepseek/u], fingerprint: 'a' },
        { ref: 'NAMED_KEY', provider: 'y', providers: ['vision-toolkit-deepseek-official'], patterns: [], fingerprint: 'b' },
    ];
    assert.equal(matchTrackedKey(keys, 'vision-toolkit-deepseek-official')?.ref, 'NAMED_KEY');
}

// ── resolution through the credential seam ──────────────────────────────────

// The credentials service is optional: a profile without one resolves from
// the launching environment instead, exactly as the provider adapters do.
{
    const credentials = { async resolve(ref) { return ref === 'DEEPSEEK_API_KEY' ? { value: KEY_A, source: 'file' } : undefined; } };
    const { keys, failures } = await resolveTrackedKeys({ credentials, trackKeys: ['DEEPSEEK_API_KEY'], env: {} });
    assert.deepEqual(failures, []);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].fingerprint, keyA);
    assert.equal(keys[0].short, keyA.slice(0, 8));
    assert.equal(keys[0].provider, 'deepseek');
    assert.equal(keys[0].source, 'file');
    assert.equal(JSON.stringify(keys).includes(KEY_A), false, 'resolution must not leak the key into the ledger state');
}

// No service mounted: the environment is the documented fallback.
{
    const { keys, failures } = await resolveTrackedKeys({ trackKeys: ['DEEPSEEK_API_KEY'], env: { DEEPSEEK_API_KEY: KEY_A } });
    assert.deepEqual(failures, []);
    assert.equal(keys[0].fingerprint, keyA);
    assert.equal(keys[0].source, 'env');
}

// Configured but unresolvable is a *failure*, not an empty success: the panel
// has to be able to say "this key is configured and I cannot see it".
{
    const { keys, failures } = await resolveTrackedKeys({ credentials: { async resolve() { return undefined; } }, trackKeys: ['DEEPSEEK_API_KEY'], env: {} });
    assert.deepEqual(keys, []);
    assert.deepEqual(failures, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek', reason: 'missing' }]);
}

// A stored value that cannot be a key is reported with the verdict, not dropped.
{
    const { keys, failures } = await resolveTrackedKeys({ credentials: { async resolve() { return { value: '  ', source: 'file' }; } }, trackKeys: ['DEEPSEEK_API_KEY'], env: {} });
    assert.deepEqual(keys, []);
    assert.deepEqual(failures, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek', reason: 'empty' }]);
}

// A throwing store must not take the ledger down with it.
{
    const { keys, failures } = await resolveTrackedKeys({ credentials: { async resolve() { throw new Error('keychain locked'); } }, trackKeys: ['DEEPSEEK_API_KEY'], env: { DEEPSEEK_API_KEY: KEY_A } });
    assert.deepEqual(keys, [], 'a throwing store does not fall through to the environment: the store answered, it just failed');
    assert.deepEqual(failures, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek', reason: 'resolveFailed', detail: 'keychain locked' }]);
}

// Two refs naming the same key are one bucket — the whole point of hashing
// the value instead of trusting the ref name.
{
    const credentials = {
        async resolve(ref) {
            return { value: KEY_A, source: 'file' };
        },
    };
    const { keys } = await resolveTrackedKeys({ credentials, trackKeys: ['DEEPSEEK_API_KEY', { ref: 'CORP_KEY', provider: 'deepseek' }], env: {} });
    assert.equal(keys.length, 2);
    assert.equal(keys[0].fingerprint, keys[1].fingerprint, 'the same key under two refs is one bucket');
}

// A pattern that does not compile is reported and dropped, while the routes
// named explicitly keep attributing — a typo shrinks nothing, it surfaces.
{
    const credentials = { async resolve() { return { value: KEY_A, source: 'file' }; } };
    const { keys, failures } = await resolveTrackedKeys({
        credentials,
        trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'], providerPatterns: ['[unclosed'] }],
        env: {},
    });
    assert.equal(keys.length, 1);
    assert.equal(keys[0].patterns.length, 0);
    assert.deepEqual(failures, [{ ref: 'DEEPSEEK_API_KEY', provider: 'deepseek-official', reason: 'invalidPattern', detail: '[unclosed' }]);
}

// End to end: a route discovered after the config was written still lands on
// the key that owns it, which is the whole reason patterns exist.
{
    const credentials = { async resolve() { return { value: KEY_A, source: 'file' }; } };
    const { keys } = await resolveTrackedKeys({
        credentials,
        trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'], providerPatterns: ['^vision-toolkit-deepseek-'] }],
        env: {},
    });
    assert.equal(matchTrackedKey(keys, 'vision-toolkit-deepseek-official-vision')?.fingerprint, keyA);
    assert.equal(matchTrackedKey(keys, 'some-other-plugin'), undefined);
}

// ── opencode's stored keys ──────────────────────────────────────────────────

// opencode holds the real key; only its hash may survive the read.
{
    const auth = {
        deepseek: { type: 'api', key: KEY_A },
        google: { type: 'oauth', refresh: 'x'.repeat(20), access: 'y'.repeat(40), expires: 1 },
        'kimi-for-coding': { type: 'api', key: KEY_B },
        broken: { type: 'api', key: '   ' },
    };
    const keys = parseOpencodeAuthKeys(auth);
    const byProvider = new Map(keys.map(entry => [entry.provider, entry]));
    assert.equal(byProvider.has('google'), false, 'a provider with no key is not a key verdict');
    assert.equal(byProvider.get('deepseek').fingerprint, keyA, 'opencode on the same key fingerprints identically to DSH');
    assert.equal(byProvider.get('deepseek').short, keyA.slice(0, 8));
    assert.notEqual(byProvider.get('kimi-for-coding').fingerprint, keyA);
    assert.deepEqual(byProvider.get('broken'), { provider: 'broken', ok: false, reason: 'empty' });
    assert.equal(JSON.stringify(keys).includes(KEY_A), false, 'the stored key must not survive into the verdict');
}

assert.deepEqual(parseOpencodeAuthKeys(null), []);
assert.deepEqual(parseOpencodeAuthKeys([]), []);
assert.deepEqual(parseOpencodeAuthKeys({ deepseek: 'not-an-object' }), []);

// The question this answers: is opencode spending MY key, or a colleague's?
{
    const tracked = await resolveTrackedKeys({ trackKeys: ['DEEPSEEK_API_KEY'], env: { DEEPSEEK_API_KEY: KEY_A } });
    const sameKey = matchOpencodeKey({ opencodeKeys: parseOpencodeAuthKeys({ deepseek: { key: KEY_A } }), keys: tracked.keys });
    assert.equal(sameKey?.provider, 'deepseek');
    assert.equal(sameKey?.key.fingerprint, keyA);
    const otherKey = matchOpencodeKey({ opencodeKeys: parseOpencodeAuthKeys({ deepseek: { key: KEY_B } }), keys: tracked.keys });
    assert.equal(otherKey, undefined, 'another key on the same provider is not mine and must not be folded in');
    assert.equal(matchOpencodeKey({ opencodeKeys: parseOpencodeAuthKeys({ deepseek: { key: '  ' } }), keys: tracked.keys }), undefined);
    assert.equal(matchOpencodeKey({ opencodeKeys: [], keys: tracked.keys }), undefined);
}

console.log('identity: ok');
