/**
 * Collector checks for dsh-month-tokens.
 *
 * The aggregator is the one component that accepts input from other machines,
 * so its two invariants are pinned here against real HTTP requests over
 * loopback: an unauthenticated caller learns nothing, and no sequence of
 * duplicate or out-of-order reports can inflate a total.
 *
 * Usage: node test/collector.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    MAX_BODY_BYTES,
    SNAPSHOT_SCHEMA,
    addBuckets,
    aggregateOf,
    bearerOf,
    bucketTotal,
    bucketsFromWire,
    createAggregateStore,
    emptyBuckets,
    normalizeSnapshot,
    snapshotKey,
    startCollector,
    sumBucketMap,
    tokenMatches,
} from '../lib/collector.js';

const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);
const TOKEN = 'test-token-0123456789';

const snapshotOf = (over = {}) => ({
    schema: SNAPSHOT_SCHEMA,
    instance: 'mac-studio',
    label: 'Mac',
    fingerprint: FP_A,
    ref: 'DEEPSEEK_API_KEY',
    month: '2026-09',
    totals: { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0 },
    days: { '2026-09-10': { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0 } },
    models: { 'deepseek-v4-pro': { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0 } },
    uncovered: ['openrouter'],
    seq: 1,
    reportedAt: 1000,
    ...over,
});

// ── untrusted buckets ───────────────────────────────────────────────────────

assert.deepEqual(bucketsFromWire({ inputTokens: 5 }), emptyBuckets(), 'unknown field names contribute nothing');
assert.deepEqual(bucketsFromWire(null), emptyBuckets());
assert.deepEqual(bucketsFromWire({ uncachedInputTokens: -999, outputTokens: Number.NaN, cacheReadTokens: '80' }), emptyBuckets(), 'a peer cannot inject a negative that cancels another machine');
assert.equal(bucketsFromWire({ uncachedInputTokens: 12.7 }).uncachedInputTokens, 12);
assert.equal(bucketsFromWire({ uncachedInputTokens: Number.MAX_SAFE_INTEGER * 4 }).uncachedInputTokens, Number.MAX_SAFE_INTEGER);

assert.deepEqual(addBuckets(emptyBuckets(), { uncachedInputTokens: 3, outputTokens: 4, cacheReadTokens: 5, cacheWriteTokens: 6 }), {
    uncachedInputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: 5,
    cacheWriteTokens: 6,
});
assert.equal(bucketTotal({ uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }), 10);

// ── wire validation ─────────────────────────────────────────────────────────

assert.equal(normalizeSnapshot(null).reason, 'notAnObject');
assert.equal(normalizeSnapshot([]).reason, 'notAnObject');
assert.equal(normalizeSnapshot({ ...snapshotOf(), schema: 'something/else' }).reason, 'schema');
assert.equal(normalizeSnapshot({ ...snapshotOf(), instance: '  ' }).reason, 'instance');
assert.equal(normalizeSnapshot({ ...snapshotOf(), fingerprint: 'nothex' }).reason, 'fingerprint');
assert.equal(normalizeSnapshot({ ...snapshotOf(), fingerprint: undefined }).reason, 'fingerprint', 'a report with no join key is refused rather than attributed to nobody');
assert.equal(normalizeSnapshot({ ...snapshotOf(), month: '2026' }).reason, 'month');
assert.equal(normalizeSnapshot({ ...snapshotOf(), seq: -1 }).reason, 'seq');
assert.equal(normalizeSnapshot({ ...snapshotOf(), seq: '3' }).reason, 'seq');

{
    const normalized = normalizeSnapshot(snapshotOf({ label: undefined, short: 'ignored', days: { '2026-09-10': { uncachedInputTokens: 5 } } }));
    assert.equal(normalized.ok, true);
    assert.equal(normalized.snapshot.label, 'mac-stud', 'a missing label falls back to the instance id');
    assert.equal(normalized.snapshot.short, FP_A.slice(0, 8), 'the display form is derived, never taken from the wire');
    assert.equal(normalized.snapshot.days['2026-09-10'].uncachedInputTokens, 5);
}

assert.equal(snapshotKey('m', FP_A), `m\u0000${FP_A}`);

// ── the store: newest wins, nothing accumulates ─────────────────────────────

{
    const store = createAggregateStore();
    const merge = over => store.merge(normalizeSnapshot(snapshotOf(over)).snapshot).reason;
    assert.equal(merge({ seq: 1, reportedAt: 1000, totals: { uncachedInputTokens: 100 } }), 'new');
    assert.equal(merge({ seq: 2, reportedAt: 2000, totals: { uncachedInputTokens: 250 } }), 'updated');
    assert.equal(store.list()[0].totals.uncachedInputTokens, 250, 'a snapshot replaces, it does not add');

    // A genuinely late packet — an older stamp, arriving after a newer one —
    // must never roll a machine's number backwards, and must not refresh
    // liveness either.
    assert.equal(merge({ seq: 1, reportedAt: 1000, totals: { uncachedInputTokens: 100 } }), 'staleReport');
    assert.equal(store.list()[0].totals.uncachedInputTokens, 250);
    assert.equal(store.list()[0].reportedAt, 2000, 'a refused packet does not move the clock');

    assert.equal(merge({ seq: 2, reportedAt: 2000, totals: { uncachedInputTokens: 250 } }), 'duplicate');

    // The restart case, which is why ordering is by stamp and not by counter:
    // a process-local `seq` restarts at zero, and a store that ordered by it
    // would lock the restarted machine out until the counter climbed past the
    // value it already held.
    assert.equal(
        merge({ seq: 0, reportedAt: 3000, totals: { uncachedInputTokens: 400 } }),
        'updated',
        'a restarted reporter must not be frozen out by its own reset counter',
    );
    assert.equal(store.list()[0].totals.uncachedInputTokens, 400);

    // Same revision, same numbers, newer stamp: alive with nothing new to say.
    // It must not read as movement, or every quiet instance would republish
    // once a minute and re-render every open panel.
    assert.equal(merge({ seq: 0, reportedAt: 4000, totals: { uncachedInputTokens: 400 } }), 'refreshed');
    assert.equal(store.list()[0].reportedAt, 4000, 'the fresher stamp is still stored, so staleness stays honest');

    // Same revision but different numbers is a buggy reporter, and its numbers
    // are still taken — silently ignoring them would under-count.
    assert.equal(merge({ seq: 0, reportedAt: 4000, totals: { uncachedInputTokens: 999 } }), 'updated');
    assert.equal(store.list()[0].totals.uncachedInputTokens, 999);

    // A second instance is a second row, not a replacement.
    assert.equal(store.merge(normalizeSnapshot(snapshotOf({ instance: 'win-box' })).snapshot).reason, 'new');
    assert.equal(store.list().length, 2);
}

// ── aggregation across instances ────────────────────────────────────────────

{
    const store = createAggregateStore();
    for (const raw of [
        snapshotOf(),
        // Deliberately two different periods: this machine's all-time figure
        // (550) exceeds what it spent this month (130), which is the only way
        // to tell whether an instance row is reporting the month or the total.
        snapshotOf({
            instance: 'win-box',
            label: 'Windows',
            seq: 3,
            totals: { uncachedInputTokens: 50, cacheReadTokens: 500 },
            days: { '2026-09-10': { uncachedInputTokens: 30, cacheReadTokens: 100 } },
        }),
    ]) {
        store.merge(normalizeSnapshot(raw).snapshot);
    }
    const aggregate = aggregateOf({ store, now: 1000 });
    assert.equal(aggregate.keys.length, 1, 'two machines on one key are one bucket');
    assert.equal(aggregate.keys[0].fingerprint, FP_A);
    assert.equal(aggregate.keys[0].totals.uncachedInputTokens, 150, 'sums across instances');
    assert.equal(aggregate.keys[0].total, 1660, 'the key total is all-time, like the local figure');
    assert.equal(aggregate.keys[0].instances.length, 2);
    const win = aggregate.keys[0].instances.find(instance => instance.instance === 'win-box');
    assert.equal(win.total, 130, 'an instance row reports the month, not the all-time figure');
    // The breakdown has to reconcile with its own headline: a panel whose rows
    // do not add up to the number above them is worse than no breakdown.
    const monthOfKey = sumBucketMap(aggregate.keys[0].days);
    assert.equal(
        aggregate.keys[0].instances.reduce((sum, instance) => sum + instance.total, 0),
        monthOfKey,
        'the instance rows add up to the key month they belong to',
    );
    assert.deepEqual(aggregate.uncovered, ['openrouter']);
    assert.deepEqual(aggregate.instances.map(i => i.instance).sort(), ['mac-studio', 'win-box']);
}

// A second key is its own bucket, and staleness is reported rather than
// silently dropping a machine that is simply switched off.
{
    const store = createAggregateStore();
    store.merge(normalizeSnapshot(snapshotOf({ reportedAt: 0 })).snapshot);
    store.merge(normalizeSnapshot(snapshotOf({ instance: 'win-box', fingerprint: FP_B, reportedAt: 1000, seq: 1 })).snapshot);
    const aggregate = aggregateOf({ store, now: 2000, staleAfterHours: 24 });
    assert.equal(aggregate.keys.length, 2);
    const byFingerprint = new Map(aggregate.keys.map(entry => [entry.fingerprint, entry]));
    assert.equal(byFingerprint.get(FP_A).instances[0].stale, true, 'no timestamp reads as stale, not as fresh');
    assert.equal(byFingerprint.get(FP_A).instances[0].ageMs, null);
    assert.equal(byFingerprint.get(FP_B).instances[0].stale, false);
    assert.equal(aggregateOf({ store, now: 1000 + 25 * 60 * 60 * 1000, staleAfterHours: 24 }).keys.find(e => e.fingerprint === FP_B).instances[0].stale, true);
}

// ── a machine that has been off since last month ────────────────────────────

// Its all-time figure must be kept — that is what "stale, not forgotten" means
// — but its *month* figure belongs to the month it last reported in. Carrying
// September's days into October would show last month's spend as this month's
// for as long as the machine stays switched off, which is exactly when nobody
// is looking closely enough to catch it.
{
    const store = createAggregateStore();
    store.merge(normalizeSnapshot(snapshotOf({
        month: '2026-09',
        totals: { uncachedInputTokens: 400, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        days: { '2026-09-30': { uncachedInputTokens: 400, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        reportedAt: 1000,
    })).snapshot);
    const october = new Date(2026, 9, 2, 12, 0, 0).getTime();
    const aggregate = aggregateOf({ store, now: october, month: '2026-10' });
    const key = aggregate.keys[0];
    assert.equal(sumBucketMap(key.days), 0, 'September\'s days are not October\'s');
    assert.equal(key.instances[0].total, 0, 'a machine that has not reported this month contributes nothing to it');
    assert.equal(key.instances[0].stale, true, 'and it is still marked stale');
    assert.equal(key.total, 400, 'while its all-time figure survives, which is the point of keeping it');

    // The same store read for the month it actually reported in still counts.
    const september = aggregateOf({ store, now: 1000 + 1000, month: '2026-09' });
    assert.equal(sumBucketMap(september.keys[0].days), 400);
    assert.equal(september.keys[0].instances[0].total, 400);

    // Without a month the caller gets the unfiltered union, as before.
    assert.equal(sumBucketMap(aggregateOf({ store, now: 1000 }).keys[0].days), 400, 'an absent month keeps the old behaviour');
}

// ── persistence ─────────────────────────────────────────────────────────────

{
    const dir = mkdtempSync(join(tmpdir(), 'dsh-collector-'));
    try {
        const file = join(dir, 'nested', 'aggregate.json');
        const store = createAggregateStore({ file });
        store.merge(normalizeSnapshot(snapshotOf()).snapshot);
        store.saveNow();
        const reopened = createAggregateStore({ file });
        assert.equal(reopened.list().length, 1, 'a restart does not forget the machines that are switched off');
        assert.equal(reopened.list()[0].totals.cacheReadTokens, 1000);
        assert.equal(createAggregateStore({ file: join(dir, 'absent.json') }).list().length, 0, 'a missing file is an empty store, not a failure');
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ── tokens ──────────────────────────────────────────────────────────────────

assert.equal(tokenMatches(TOKEN, TOKEN), true);
assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false);
assert.equal(tokenMatches(TOKEN, 'short'), false);
assert.equal(tokenMatches(TOKEN, undefined), false);
assert.equal(tokenMatches(undefined, undefined), false, 'an unconfigured token must never match');
assert.equal(tokenMatches('', ''), false);
assert.equal(bearerOf(`Bearer ${TOKEN}`), TOKEN);
assert.equal(bearerOf(`  bearer ${TOKEN}  `), undefined, 'the scheme is case-sensitive as written in RFC 6750');
assert.equal(bearerOf(undefined), undefined);
assert.equal(bearerOf('Basic abc'), undefined);

// ── the listener, over real HTTP ────────────────────────────────────────────

{
    const store = createAggregateStore();
    const started = startCollector({ token: TOKEN, store, port: 0 });
    assert.equal(started.ok, true);
    const server = started.server;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body, token) => fetch(`${base}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    try {
        // Reachability is checkable before a token is known to work, and
        // reveals no data.
        const health = await fetch(`${base}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), { ok: true, service: 'dsh-month-tokens' });

        assert.equal((await fetch(`${base}/aggregate`)).status, 401, 'the aggregate is not readable without a token');
        assert.equal((await post(snapshotOf(), undefined)).status, 401);
        assert.equal((await post(snapshotOf(), 'wrong-token-00000000')).status, 401);

        const accepted = await post(snapshotOf(), TOKEN);
        assert.equal(accepted.status, 200);
        assert.deepEqual(await accepted.json(), { ok: true, changed: true, reason: 'new' });

        const resent = await post(snapshotOf(), TOKEN);
        assert.deepEqual(await resent.json(), { ok: true, changed: false, reason: 'duplicate' }, 'a duplicate report is accepted and ignored');

        assert.equal((await post('{not json', TOKEN)).status, 400);
        assert.equal((await post({ ...snapshotOf(), schema: 'nope' }, TOKEN)).status, 400);
        assert.equal((await post(JSON.stringify({ ...snapshotOf(), pad: 'x'.repeat(MAX_BODY_BYTES + 1024) }), TOKEN)).status, 413);

        const aggregate = await (await fetch(`${base}/aggregate`, { headers: { authorization: `Bearer ${TOKEN}` } })).json();
        assert.equal(aggregate.keys[0].totals.uncachedInputTokens, 100);
        assert.equal(aggregate.instances[0].instance, 'mac-studio');

        assert.equal((await fetch(`${base}/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })).status, 404);
    } finally {
        await new Promise(resolve => server.close(resolve));
        store.close();
    }
}

// A listener without a token refuses to start rather than serving openly.
assert.deepEqual(startCollector({ token: '', store: createAggregateStore() }), { ok: false, reason: 'noToken' });
assert.deepEqual(startCollector({ store: createAggregateStore() }), { ok: false, reason: 'noToken' });

console.log('collector: ok');
