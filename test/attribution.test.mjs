/**
 * Attribution checks for dsh-month-tokens.
 *
 * The fold here has one job that must not be got wrong: a retried attempt
 * must replace the sample it supersedes, never add to it. A ledger that
 * double-counts retries still looks plausible, which is exactly what makes it
 * dangerous, so the replacement rule is pinned against the official
 * projection's behaviour in both directions.
 *
 * Real zstd frames are written to a temporary directory and scanned, so the
 * incremental path is exercised end to end rather than mocked.
 *
 * Usage: node test/attribution.test.mjs
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import {
    UNATTRIBUTED,
    bucketKey,
    bucketsFrom,
    createScanState,
    dayKeyOf,
    decodeFrame,
    foldEvents,
    framesIn,
    listSessionLogs,
    parseBucketKey,
    scanSessionLog,
    usageOf,
    zstdAvailable,
} from '../lib/attribution.js';
import { fingerprintOfKey } from '../lib/identity.js';

const KEY = 'sk-00000000000000000000000000000001';
const FP = fingerprintOfKey(KEY).fingerprint;

// A tracked key that owns the shipped adapter's route plus the routes other
// plugins were measured registering against the same credential.
const KEYS = [{
    ref: 'DEEPSEEK_API_KEY',
    provider: 'deepseek-official',
    providers: ['deepseek-official'],
    patterns: [/^vision-toolkit-deepseek-/u],
    fingerprint: FP,
}];

// Midday local, so no timezone shifts the day under the assertion.
const T1 = new Date(2026, 8, 10, 12, 0, 0).getTime();
const T2 = new Date(2026, 8, 11, 12, 0, 0).getTime();
const DAY1 = dayKeyOf(T1);
const DAY2 = dayKeyOf(T2);

const context = (provider, model, time = T1) => ({ type: 'request/context', time, data: { provider, model, contextWindow: 1000 } });
const message = (turn, step, usage, time = T1) => ({ type: 'assistant/message', time, data: { turn, step, usage } });
const retry = (turn, step, time = T1) => ({ type: 'llm/retry-started', time, data: { turn, step } });
const totalsAt = (state, owner, day, model) => state.buckets[bucketKey(owner, day, model)];

// ── day keys are local, not UTC ─────────────────────────────────────────────

assert.equal(dayKeyOf(new Date(2026, 0, 1, 0, 0, 0).getTime()), '2026-01-01', 'the first minute of the month belongs to that month');
assert.equal(dayKeyOf(new Date(2026, 11, 31, 23, 59, 59).getTime()), '2026-12-31');
assert.equal(dayKeyOf(undefined), undefined);
assert.equal(dayKeyOf(Number.NaN), undefined);
assert.equal(dayKeyOf('2026-09-10'), undefined);

// ── bucket keys round-trip ──────────────────────────────────────────────────

assert.deepEqual(parseBucketKey(bucketKey('fp', '2026-09-10', 'deepseek-v4-pro')), { owner: 'fp', day: '2026-09-10', model: 'deepseek-v4-pro' });

// ── usage reading ───────────────────────────────────────────────────────────

assert.deepEqual(bucketsFrom({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 300 }), {
    uncachedInputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 300,
    cacheWriteTokens: 0,
});
assert.deepEqual(bucketsFrom({ inputTokens: -5, outputTokens: Number.NaN }), {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
}, 'a negative or unusable count contributes nothing rather than subtracting');

assert.equal(usageOf({ type: 'assistant/message', data: { usage: { inputTokens: 1 } } })?.inputTokens, 1);
assert.equal(usageOf({ type: 'assistant/message', data: { stream: [{ type: 'text' }, { type: 'usage', usage: { inputTokens: 7 } }] } })?.inputTokens, 7, 'a settlement that only embedded usage in its stream is still read');
assert.equal(usageOf({ type: 'assistant/message', data: {} }), undefined);
assert.equal(usageOf({ type: 'user/message', data: { usage: { inputTokens: 1 } } }), undefined);

assert.deepEqual(decodeFrame('{"type":"a"}\nnot json\n{"type":"b"}\n'), [{ type: 'a' }, { type: 'b' }]);

// ── attribution ─────────────────────────────────────────────────────────────

{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'deepseek-v4-pro'),
        message(1, 1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 5000 }),
    ], KEYS);
    assert.deepEqual(totalsAt(state, FP, DAY1, 'deepseek-v4-pro'), {
        uncachedInputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5000,
        cacheWriteTokens: 0,
    });
    assert.deepEqual(Object.keys(state.uncovered), [], 'a covered route raises no coverage warning');
}

// A route the config has not learned yet is claimed by the pattern.
{
    const state = createScanState();
    foldEvents(state, [
        context('vision-toolkit-deepseek-official-vision', 'deepseek-v4-flash-vision-exp'),
        message(1, 1, { inputTokens: 40 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'deepseek-v4-flash-vision-exp')?.uncachedInputTokens, 40, 'a plugin route resolving the same key lands in the same bucket');
}

// A route nobody tracks is reported, not folded in.
{
    const state = createScanState();
    foldEvents(state, [context('openrouter', 'x'), message(1, 1, { inputTokens: 9 })], KEYS);
    assert.equal(totalsAt(state, UNATTRIBUTED, DAY1, 'x')?.uncachedInputTokens, 9);
    assert.equal(totalsAt(state, FP, DAY1, 'x'), undefined, 'untracked usage must never reach the tracked bucket');
    assert.deepEqual(Object.keys(state.uncovered), ['openrouter']);
}

// Different models under one key are separate buckets, and the day is taken
// from the event rather than the scan.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'deepseek-v4-pro'),
        message(1, 1, { inputTokens: 10 }, T1),
        context('deepseek-official', 'deepseek-v4-flash', T2),
        message(2, 1, { inputTokens: 20 }, T2),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'deepseek-v4-pro')?.uncachedInputTokens, 10);
    assert.equal(totalsAt(state, FP, DAY2, 'deepseek-v4-flash')?.uncachedInputTokens, 20);
}

// ── the replacement rule ────────────────────────────────────────────────────

// A resettled slot replaces its sample instead of accumulating.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 100 }),
        message(1, 1, { inputTokens: 150 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 150, 'a resent settlement replaces, it does not add');
}

// Repeating the identical sample is a no-op, as in the official projection.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 100 }),
        message(1, 1, { inputTokens: 100 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 100);
}

// A retry closes the slot, so the next sample ADDS. This is the direction
// that silently under-counts if the slot is never closed.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 100 }),
        retry(1, 1),
        message(1, 1, { inputTokens: 150 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 250, 'a retried attempt counts on top of the attempt it replaced');
}

// A retry for a different slot leaves the open slot alone.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 100 }),
        retry(9, 9),
        message(1, 1, { inputTokens: 150 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 150);
}

// Replacement has to undo the *original* bucket, which may differ when the
// route changed between attempts. A naive "subtract from the current bucket"
// would leave the tracked bucket inflated by usage that was never its own.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 100 }),
        context('openrouter', 'm'),
        message(1, 1, { inputTokens: 30 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm'), undefined, 'the replaced sample is removed from the bucket it was added to');
    assert.equal(totalsAt(state, UNATTRIBUTED, DAY1, 'm')?.uncachedInputTokens, 30);
}

// ── a forked session's inherited prefix belongs to its parent ───────────────

// A seeded session opens with a copy of the events it was forked from. Those
// settlements were already counted in the parent's own log, so folding them
// again would charge the same tokens twice — measured at 117,987 per fork on
// this machine, small but real, and unbounded in principle.
{
    const state = createScanState();
    foldEvents(state, [
        { type: 'session', id: 'session-child', isSeeded: true, createdAt: T1 },
        { type: 'request/context', time: T1, data: { provider: 'deepseek-official', model: 'm' } },
        // inherited: the parent's tokens, replayed into this log
        message(1, 1, { inputTokens: 999 }),
        { type: 'session/end-seed', time: T1 },
        // the fork's own work: this is what it actually cost
        message(2, 1, { inputTokens: 40, outputTokens: 4 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 40, 'only the work after the cut is this session\'s');
    assert.equal(state.skippedInherited, 1, 'and the inherited settlement is counted as skipped, not as tokens');
}

// A session that was not seeded has no prefix, so nothing is skipped.
{
    const state = createScanState();
    foldEvents(state, [
        { type: 'session', id: 'session-plain', isSeeded: false, createdAt: T1 },
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 7 }),
    ], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 7);
    assert.equal(state.skippedInherited, 0);
}

// An incremental pass never sees the header again, so the flag has to survive
// in the state — a prefix that resumed counting would silently re-add it.
{
    const state = createScanState();
    foldEvents(state, [
        { type: 'session', id: 'session-child', isSeeded: true, createdAt: T1 },
        context('deepseek-official', 'm'),
        message(1, 1, { inputTokens: 999 }),
    ], KEYS);
    assert.equal(state.seedPending, true, 'the cut has not been seen yet');
    foldEvents(state, [message(2, 1, { inputTokens: 5 })], KEYS);
    assert.equal(state.skippedInherited, 2, 'later passes stay inside the prefix until the cut');
    assert.deepEqual(Object.keys(state.buckets), []);
    foldEvents(state, [{ type: 'session/end-seed', time: T1 }, message(3, 1, { inputTokens: 50 })], KEYS);
    assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 50, 'and the prefix is not re-added after it');
}

// A call the provider never weighs is counted, never guessed at.
{
    const state = createScanState();
    foldEvents(state, [
        context('deepseek-official', 'm'),
        { type: 'web/deepseek-search-llm-request', time: T1, data: { endpoint: 'https://api.deepseek.com/anthropic/v1/messages', apiVersion: '2023-06-01', body: {} } },
        { type: 'web/deepseek-search-llm-request', time: T1, data: {} },
    ], KEYS);
    assert.equal(state.uncountedWebSearch, 2, 'the search path reports no tokens anywhere, so it is counted instead of estimated');
    assert.deepEqual(Object.keys(state.buckets), [], 'and no token figure is invented for it');
}
assert.equal(createScanState().uncountedWebSearch, 0);

// An event with no usable time is surfaced, not filed under a guessed month.
{
    const state = createScanState();
    foldEvents(state, [context('deepseek-official', 'm'), { type: 'assistant/message', data: { turn: 1, step: 1, usage: { inputTokens: 5 } } }], KEYS);
    assert.deepEqual(Object.keys(state.uncovered), ['deepseek-official (undated)']);
    assert.deepEqual(Object.keys(state.buckets), [], 'undated usage is not attributed to any day');
}

// ── frame splitting ─────────────────────────────────────────────────────────

if (!zstdAvailable()) {
    console.log('attribution: ok (zstd unavailable — frame and scan checks skipped)');
} else {
    const frameOf = events => zlib.zstdCompressSync(Buffer.from(`${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8'));

    const one = frameOf([context('deepseek-official', 'm'), message(1, 1, { inputTokens: 100 })]);
    const two = frameOf([message(2, 1, { inputTokens: 50 })]);
    const joined = Buffer.concat([one, two]);
    const frames = framesIn(joined, 0);
    assert.equal(frames.length, 2, 'each appended batch is its own frame');
    assert.equal(frames[0].start, 0);
    assert.equal(frames[0].end, one.length);
    assert.equal(frames[1].end, joined.length);

    // Offsets are absolute, so a tail read reports the same boundaries.
    const tail = joined.subarray(one.length);
    const tailFrames = framesIn(tail, one.length);
    assert.deepEqual(tailFrames.map(frame => [frame.start, frame.end]), [[one.length, joined.length]]);

    const dir = mkdtempSync(join(tmpdir(), 'dsh-tokens-'));
    try {
        const sessionDir = join(dir, 'sessions', '--w--', 'session-abc');
        mkdirSync(sessionDir, { recursive: true });
        const logPath = join(sessionDir, 'session.v3.jsonl.zstd');
        writeFileSync(logPath, one);

        const state = createScanState();
        assert.equal(scanSessionLog({ path: logPath, state, keys: KEYS }), 1);
        assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 100);
        assert.equal(state.processedBytes, one.length);

        // Nothing appended: the scan does not even read.
        assert.equal(scanSessionLog({ path: logPath, state, keys: KEYS }), 0);
        assert.equal(state.frames, 1);

        // Appending resumes at the offset rather than re-reading history.
        appendFileSync(logPath, two);
        assert.equal(scanSessionLog({ path: logPath, state, keys: KEYS }), 1);
        assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 150);

        // Incremental and full scans must agree — the property that makes the
        // offset safe to persist.
        const fresh = createScanState();
        scanSessionLog({ path: logPath, state: fresh, keys: KEYS });
        assert.deepEqual({ ...fresh.buckets }, { ...state.buckets }, 'incremental and full scans agree');
        assert.equal(fresh.processedBytes, state.processedBytes);

        // A half-written append is not consumed, and is picked up once complete.
        const third = frameOf([message(3, 1, { inputTokens: 7 })]);
        appendFileSync(logPath, third.subarray(0, third.length - 4));
        assert.equal(scanSessionLog({ path: logPath, state, keys: KEYS }), 0, 'a truncated frame is not consumed');
        assert.equal(state.processedBytes, one.length + two.length);
        appendFileSync(logPath, third.subarray(third.length - 4));
        assert.equal(scanSessionLog({ path: logPath, state, keys: KEYS }), 1, 'the completed frame is consumed on the next pass');
        assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 157);

        // The slot survives across scans. A retry closed in a *later* frame
        // still finds the slot it must close, so the retried attempt adds:
        // both attempts were billed. The value discriminates pass-persistent
        // slot state (164) from state rebuilt each pass (157, where the retry
        // would miss and the identical resend would read as a no-op).
        const fourth = frameOf([retry(3, 1), message(3, 1, { inputTokens: 7 })]);
        appendFileSync(logPath, fourth);
        scanSessionLog({ path: logPath, state, keys: KEYS });
        assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, 164, 'a retry spans passes without losing the slot it closes');

        // The more important direction: a settlement resent in a later frame
        // replaces the sample an earlier frame contributed instead of adding.
        appendFileSync(logPath, frameOf([message(4, 1, { inputTokens: 5 })]));
        scanSessionLog({ path: logPath, state, keys: KEYS });
        const beforeResend = totalsAt(state, FP, DAY1, 'm').uncachedInputTokens;
        appendFileSync(logPath, frameOf([message(4, 1, { inputTokens: 8 })]));
        scanSessionLog({ path: logPath, state, keys: KEYS });
        assert.equal(totalsAt(state, FP, DAY1, 'm')?.uncachedInputTokens, beforeResend - 5 + 8, 'a resent settlement replaces across scans');

        // Discovery walks the documented layout and accepts both log names.
        const found = listSessionLogs({ sessionsDir: join(dir, 'sessions') });
        assert.equal(found.length, 1);
        assert.equal(found[0].sessionId, 'session-abc');
        assert.equal(found[0].path, logPath);
        assert.deepEqual(listSessionLogs({ sessionsDir: join(dir, 'nope') }), [], 'a missing sessions directory is empty, not fatal');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    console.log('attribution: ok');
}
