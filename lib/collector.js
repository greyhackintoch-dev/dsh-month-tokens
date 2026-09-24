/**
 * The cross-machine join: one aggregator, absolute snapshots, no deltas.
 *
 * Every instance reports the *whole* current value of the buckets it owns,
 * keyed by credential fingerprint, and the aggregator keeps the newest
 * snapshot per `(instance, fingerprint)`. That choice is the whole design:
 *
 * - **Idempotent.** A resend, an out-of-order arrival, or a duplicate after a
 *   retry cannot inflate the total, because nothing is ever accumulated —
 *   a snapshot replaces the one before it.
 * - **Self-healing.** A dropped report costs nothing permanent: the next one
 *   carries the full value again, so the aggregate converges without a
 *   replay log or an acknowledgement protocol.
 * - **Restart-safe.** What persists is the per-instance value, not a running
 *   sum, so an aggregator restart cannot double-count a replayed report.
 *
 * What crosses the wire is counts and a key fingerprint. No key, no prompt,
 * no model output, no session content. The listener is separate from the
 * GUI's own server and is never exposed by turning on `networkExposure`.
 *
 * @module dsh-month-tokens/collector
 */
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** The wire schema id, so a future shape cannot be mistaken for this one. */
export const SNAPSHOT_SCHEMA = 'dsh-month-tokens/snapshot/v1';

/** The largest report accepted, in bytes. A snapshot is counts; anything larger is not one. */
export const MAX_BODY_BYTES = 256 * 1024;

/** The three totals-shaped fields a snapshot may carry. */
const BUCKET_FIELDS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** A zeroed bucket set. */
export function emptyBuckets() {
    return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Read one untrusted bucket set off the wire.
 *
 * Every field is coerced to a non-negative safe integer, so a hostile or
 * broken reporter cannot inject a negative value that would silently cancel
 * another machine's real usage — the one arithmetic an aggregator must not
 * trust its peers for.
 *
 * @param raw - the value as received.
 * @returns a bucket set, never `undefined`.
 */
export function bucketsFromWire(raw) {
    const buckets = emptyBuckets();
    if (raw === null || typeof raw !== 'object') {
        return buckets;
    }
    for (const field of BUCKET_FIELDS) {
        const value = raw[field];
        if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
            buckets[field] = Math.min(Math.trunc(value), Number.MAX_SAFE_INTEGER);
        }
    }
    return buckets;
}

/** Add `source` into `target` in place. */
export function addBuckets(target, source) {
    for (const field of BUCKET_FIELDS) {
        target[field] += source[field];
    }
    return target;
}

/** The sum of every field, for a one-number headline. */
export function bucketTotal(buckets) {
    let total = 0;
    for (const field of BUCKET_FIELDS) {
        total += buckets[field];
    }
    return total;
}

/**
 * The sum of a `{ name: buckets }` map, optionally restricted to a prefix.
 *
 * Used for a snapshot's day buckets, which are month-scoped: the result is the
 * figure that belongs beside the key's month, not beside its all-time total.
 * The prefix exists for the month boundary — see {@link aggregateOf}.
 *
 * @param map - a day- or model-keyed bucket map.
 * @param prefix - when given, only keys starting with it are counted.
 * @returns total tokens across the counted entries.
 */
export function sumBucketMap(map, prefix) {
    let total = 0;
    for (const [key, buckets] of Object.entries(map)) {
        if (prefix !== undefined && !key.startsWith(prefix)) {
            continue;
        }
        total += bucketTotal(buckets);
    }
    return total;
}

/**
 * Validate and normalize one reported snapshot.
 *
 * @param raw - the decoded request body.
 * @returns the normalized snapshot, or why it cannot be accepted.
 */
export function normalizeSnapshot(raw) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { ok: false, reason: 'notAnObject' };
    }
    if (raw.schema !== SNAPSHOT_SCHEMA) {
        return { ok: false, reason: 'schema' };
    }
    const instance = text(raw.instance);
    if (instance === undefined) {
        return { ok: false, reason: 'instance' };
    }
    const fingerprint = text(raw.fingerprint);
    // The fingerprint is the join key; without it there is no bucket, and
    // inventing one would attribute real usage to nobody.
    if (fingerprint === undefined || !/^[0-9a-f]{64}$/u.test(fingerprint)) {
        return { ok: false, reason: 'fingerprint' };
    }
    const month = text(raw.month);
    if (month === undefined || !/^\d{4}-\d{2}$/u.test(month)) {
        return { ok: false, reason: 'month' };
    }
    const seq = raw.seq;
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) {
        return { ok: false, reason: 'seq' };
    }
    return {
        ok: true,
        snapshot: {
            schema: SNAPSHOT_SCHEMA,
            instance,
            label: text(raw.label) ?? instance.slice(0, 8),
            fingerprint,
            short: fingerprint.slice(0, 8),
            ref: text(raw.ref) ?? null,
            month,
            totals: bucketsFromWire(raw.totals),
            days: bucketMapFromWire(raw.days),
            models: bucketMapFromWire(raw.models),
            uncovered: stringListFromWire(raw.uncovered),
            seq: Math.trunc(seq),
            reportedAt: typeof raw.reportedAt === 'number' && Number.isFinite(raw.reportedAt) ? raw.reportedAt : 0,
        },
    };
}

/** A non-empty trimmed string, or `undefined`. */
function text(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
}

/** A `{ key: buckets }` map with a bounded number of entries. */
function bucketMapFromWire(raw) {
    const map = Object.create(null);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return map;
    }
    let count = 0;
    for (const [key, value] of Object.entries(raw)) {
        if (count >= 512) {
            break;
        }
        const name = text(key);
        if (name === undefined) {
            continue;
        }
        map[name] = bucketsFromWire(value);
        count += 1;
    }
    return map;
}

/** A bounded list of short strings. */
function stringListFromWire(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const list = [];
    for (const entry of raw) {
        const value = text(entry);
        if (value !== undefined && list.length < 128) {
            list.push(value);
        }
    }
    return list;
}

/** The store key of one instance's report about one key. */
export function snapshotKey(instance, fingerprint) {
    return `${instance}\u0000${fingerprint}`;
}

/**
 * Whether two bucket sets carry the same numbers.
 */
function sameBuckets(left, right) {
    return BUCKET_FIELDS.every(field => left[field] === right[field]);
}

/** Whether two `{ name: buckets }` maps carry the same numbers. */
function sameBucketMap(left, right) {
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) {
        return false;
    }
    return keys.every(key => right[key] !== undefined && sameBuckets(left[key], right[key]));
}

/**
 * Whether two snapshots would produce the same aggregate.
 *
 * Liveness (`reportedAt`) and revision (`seq`) are deliberately excluded: this
 * answers "would the numbers move?", which is the only question a caller needs
 * answered before republishing to every open panel.
 */
function sameNumbers(left, right) {
    if (!sameBuckets(left.totals, right.totals) || !sameBucketMap(left.days, right.days) || !sameBucketMap(left.models, right.models)) {
        return false;
    }
    if (left.uncovered.length !== right.uncovered.length) {
        return false;
    }
    return left.uncovered.every((name, index) => name === right.uncovered[index]);
}

/**
 * Create the snapshot store an aggregator keeps.
 *
 * Persisted as one JSON file so an aggregator restart does not forget the
 * machines that are not currently running — losing them would make the
 * headline dip for reasons that have nothing to do with usage.
 *
 * @param options - store inputs.
 * @param options.file - the JSON file to persist to, or `undefined` for memory only.
 * @returns the store.
 */
export function createAggregateStore(options = {}) {
    const { file } = options;
    const snapshots = new Map();
    if (file !== undefined) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8'));
            if (parsed !== null && typeof parsed === 'object' && parsed.snapshots !== null && typeof parsed.snapshots === 'object') {
                for (const [key, value] of Object.entries(parsed.snapshots)) {
                    const normalized = normalizeSnapshot({ ...value, schema: value?.schema ?? SNAPSHOT_SCHEMA });
                    if (normalized.ok) {
                        snapshots.set(key, normalized.snapshot);
                    }
                }
            }
        } catch {
            // A missing or unreadable file is an empty store, not a failure:
            // the next report from every instance rebuilds it.
        }
    }
    let saveTimer;
    const store = {
        snapshots,
        /** Every snapshot currently held. */
        list() {
            return [...snapshots.values()];
        },
        /**
         * Merge one report.
         *
         * Ordering is by `(reportedAt, seq)`, not by `seq` alone — and that
         * choice is load-bearing. A reporter's `seq` is a process-local
         * counter, so it restarts at zero whenever the machine reboots or DSH
         * is restarted. Ordering by `seq` alone would then reject every report
         * from the restarted machine until it climbed past the value the
         * aggregator already held, freezing that machine's contribution for as
         * long as it took — silently, and with no error on either side.
         * Ordering by the report's wall-clock stamp first lets the restarted
         * reporter win immediately, while a genuinely late packet (an older
         * stamp, arriving after a newer one) is still refused, which is the
         * protection the sequence number was there to provide.
         *
         * @param snapshot - a normalized snapshot.
         * @returns whether the store changed, and why.
         */
        merge(snapshot) {
            const key = snapshotKey(snapshot.instance, snapshot.fingerprint);
            const held = snapshots.get(key);
            const stale = held !== undefined
                && (snapshot.reportedAt < held.reportedAt
                    || (snapshot.reportedAt === held.reportedAt && snapshot.seq < held.seq));
            if (stale) {
                return { changed: false, reason: 'staleReport' };
            }
            const sameRevision = held !== undefined && snapshot.reportedAt === held.reportedAt && snapshot.seq === held.seq;
            if (sameRevision && !sameNumbers(held, snapshot)) {
                // A reporter that reuses a revision for different numbers is
                // buggy; its numbers are still taken, because ignoring them
                // would under-count, which is the worse failure.
                snapshots.set(key, snapshot);
                store.scheduleSave();
                return { changed: true, reason: 'updated' };
            }
            // Same revision, same numbers, newer stamp: the machine is alive
            // and has nothing new to say. Storing the fresher stamp is what
            // keeps staleness honest, but reporting `changed` here would make
            // every quiet instance bump the revision once a minute and
            // re-render every open panel for no movement at all.
            if (held !== undefined && sameNumbers(held, snapshot)) {
                snapshots.set(key, snapshot);
                store.scheduleSave();
                return { changed: false, reason: held.reportedAt === snapshot.reportedAt ? 'duplicate' : 'refreshed' };
            }
            snapshots.set(key, snapshot);
            store.scheduleSave();
            return { changed: true, reason: held === undefined ? 'new' : 'updated' };
        },
        /** Persist after a short quiet period, so a burst writes once. */
        scheduleSave() {
            if (file === undefined || saveTimer !== undefined) {
                return;
            }
            saveTimer = setTimeout(() => {
                saveTimer = undefined;
                store.saveNow();
            }, 250);
            saveTimer.unref?.();
        },
        /** Persist immediately. */
        saveNow() {
            if (file === undefined) {
                return;
            }
            try {
                mkdirSync(dirname(file), { recursive: true });
                const temp = `${file}.tmp`;
                writeFileSync(temp, JSON.stringify({ version: 1, snapshots: Object.fromEntries(snapshots) }), 'utf8');
                renameSync(temp, file);
            } catch {
                // Persistence is a convenience; the in-memory store is the
                // truth for this process and rebuilds on the next report.
            }
        },
        /** Stop the pending save timer, flushing first. */
        close() {
            if (saveTimer !== undefined) {
                clearTimeout(saveTimer);
                saveTimer = undefined;
                store.saveNow();
            }
        },
    };
    return store;
}

/**
 * Fold every held snapshot into the numbers the panel shows.
 *
 * @param options - fold inputs.
 * @param options.store - the snapshot store.
 * @param options.now - the current time, for staleness.
 * @param options.staleAfterHours - how long without a report before an instance is flagged.
 * @returns per-key totals, per-instance freshness, and the uncovered routes reported by peers.
 */
export function aggregateOf(options) {
    const { store, now = Date.now(), staleAfterHours = 24, month } = options;
    const staleAfterMs = staleAfterHours * 60 * 60 * 1000;
    // `month` is the month the caller is reading *for*, and it is what keeps a
    // switched-off machine from donating last month's figure to this one. A
    // snapshot's `days` are dated, so they can be filtered per day; its `models`
    // carry no date at all, so they are filtered by the month the snapshot
    // itself declares. Omitting `month` keeps the unfiltered union, which is
    // what a caller that is not asking about a month should get.
    const prefix = typeof month === 'string' && /^\d{4}-\d{2}$/u.test(month) ? `${month}-` : undefined;
    const keys = new Map();
    const instances = new Map();
    const uncovered = new Set();
    for (const snapshot of store.list()) {
        const age = snapshot.reportedAt === 0 ? Number.POSITIVE_INFINITY : now - snapshot.reportedAt;
        const stale = age > staleAfterMs;
        let entry = keys.get(snapshot.fingerprint);
        if (entry === undefined) {
            entry = {
                fingerprint: snapshot.fingerprint,
                short: snapshot.short,
                ref: snapshot.ref,
                totals: emptyBuckets(),
                days: new Map(),
                models: new Map(),
                instances: [],
            };
            keys.set(snapshot.fingerprint, entry);
        }
        addBuckets(entry.totals, snapshot.totals);
        const inMonth = prefix === undefined || snapshot.month === month;
        for (const [day, buckets] of Object.entries(snapshot.days)) {
            if (prefix !== undefined && !day.startsWith(prefix)) continue;
            let held = entry.days.get(day);
            if (held === undefined) {
                held = emptyBuckets();
                entry.days.set(day, held);
            }
            addBuckets(held, buckets);
        }
        if (inMonth) {
            for (const [model, buckets] of Object.entries(snapshot.models)) {
                let held = entry.models.get(model);
                if (held === undefined) {
                    held = emptyBuckets();
                    entry.models.set(model, held);
                }
                addBuckets(held, buckets);
            }
        }
        for (const provider of snapshot.uncovered) {
            uncovered.add(provider);
        }
        entry.instances.push({
            instance: snapshot.instance,
            label: snapshot.label,
            month: snapshot.month,
            seq: snapshot.seq,
            reportedAt: snapshot.reportedAt,
            ageMs: Number.isFinite(age) ? age : null,
            stale,
            // The instance row answers "what did this machine contribute to the
            // month", so it is the sum of its *day* buckets — the same period as
            // the key's `month`, which the rows must add up to. A snapshot's
            // `totals` are all-time and belong to the key's all-time figure; a
            // row labelled by month showing a cumulative number is exactly the
            // two-periods-without-saying-so error this ledger exists to avoid.
            total: sumBucketMap(snapshot.days, prefix),
        });
        const known = instances.get(snapshot.instance);
        const seen = snapshot.reportedAt;
        if (known === undefined) {
            instances.set(snapshot.instance, { instance: snapshot.instance, label: snapshot.label, reportedAt: seen, stale, keys: 1 });
        } else {
            known.keys += 1;
            if (seen > known.reportedAt) {
                known.reportedAt = seen;
                known.stale = stale;
            }
        }
    }
    return {
        keys: [...keys.values()].map(entry => ({
            ...entry,
            days: Object.fromEntries(entry.days),
            models: Object.fromEntries(entry.models),
            total: bucketTotal(entry.totals),
            instances: entry.instances.sort((left, right) => right.reportedAt - left.reportedAt),
        })).sort((left, right) => right.total - left.total),
        instances: [...instances.values()],
        uncovered: [...uncovered].sort(),
    };
}

/**
 * Whether a presented bearer token matches the expected one.
 *
 * The comparison is length-checked and constant-time: a token is a secret,
 * and an aggregator that answers in variable time leaks it a byte at a time.
 *
 * @param expected - the configured token.
 * @param presented - the token from the request.
 * @returns whether the request may proceed.
 */
export function tokenMatches(expected, presented) {
    if (typeof expected !== 'string' || expected.length === 0) {
        return false;
    }
    if (typeof presented !== 'string' || presented.length !== expected.length) {
        return false;
    }
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(presented, 'utf8'));
}

/** The bearer token of a request, or `undefined`. */
export function bearerOf(header) {
    if (typeof header !== 'string') {
        return undefined;
    }
    const match = /^Bearer (.+)$/u.exec(header.trim());
    return match === null ? undefined : match[1].trim();
}

/**
 * Start the aggregator's own listener.
 *
 * Deliberately not the GUI's server: enabling this must not require
 * `networkExposure`, which would publish every other route with it.
 *
 * @param options - listener inputs.
 * @param options.token - the shared bearer token; a listener without one refuses to start.
 * @param options.store - the snapshot store.
 * @param options.host - the interface to bind; loopback unless a peer needs more.
 * @param options.port - the port; 0 asks the OS for one.
 * @returns the running listener, or why it could not start.
 */
export function startCollector(options) {
    const { token, store, host = '127.0.0.1', port = 3939 } = options;
    if (typeof token !== 'string' || token.length === 0) {
        return { ok: false, reason: 'noToken' };
    }
    const server = createServer((request, response) => {
        const url = request.url ?? '/';
        const path = url.split('?')[0];
        // Health is deliberately data-free and token-free: it exists so a new
        // machine can prove reachability before its token is known to work.
        if (request.method === 'GET' && path === '/health') {
            respond(response, 200, { ok: true, service: 'dsh-month-tokens' });
            return;
        }
        if (!tokenMatches(token, bearerOf(request.headers.authorization))) {
            respond(response, 401, { ok: false, error: 'unauthorized' });
            return;
        }
        if (request.method === 'POST' && path === '/ingest') {
            readBody(request, (error, body) => {
                if (error !== undefined) {
                    respond(response, error === 'tooLarge' ? 413 : 400, { ok: false, error });
                    return;
                }
                let parsed;
                try {
                    parsed = JSON.parse(body);
                } catch {
                    respond(response, 400, { ok: false, error: 'malformedJson' });
                    return;
                }
                const normalized = normalizeSnapshot(parsed);
                if (!normalized.ok) {
                    respond(response, 400, { ok: false, error: normalized.reason });
                    return;
                }
                const merged = store.merge(normalized.snapshot);
                respond(response, 200, { ok: true, changed: merged.changed, reason: merged.reason });
            });
            return;
        }
        if (request.method === 'GET' && path === '/aggregate') {
            respond(response, 200, aggregateOf({ store }));
            return;
        }
        respond(response, 404, { ok: false, error: 'notFound' });
    });
    return { ok: true, server, host, port };
}

/** Accumulate a request body under the cap. */
function readBody(request, done) {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            done('tooLarge');
            request.destroy();
            return;
        }
        chunks.push(chunk);
    });
    request.on('end', () => done(undefined, Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => done('readError'));
}

/** Send one JSON response. */
function respond(response, status, body) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        // No CORS header: a cross-origin page must not be able to read this,
        // even if it somehow reaches the port.
        'cache-control': 'no-store',
    });
    response.end(payload);
}
