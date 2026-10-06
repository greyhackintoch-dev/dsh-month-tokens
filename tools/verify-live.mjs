#!/usr/bin/env node
/**
 * Drive the real host plugin against this machine's real DSH home.
 *
 * A verification harness, not a product surface. It supplies the four services
 * `apply()` reads — attached sessions, their projections, the durable
 * projection cache, and a route registry — from the actual `~/.dsh` directories,
 * then prints the payload the panel would render.
 *
 * It is here because the one thing a hermetic suite cannot check is whether the
 * fix lands on real data: the fixtures prove the rule, this proves the number.
 *
 * Read-only. Prints counts only, never a key.
 *
 * Usage: node tools/verify-live.mjs [--home DIR] [--sessions DIR]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../lib/index.js';
import { credentialFromStore } from './tracked-report.mjs';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const sessionsDir = join(DSH_HOME, 'sessions');
const cacheDir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');

/** Every durable projection record, keyed by session id. */
function cachedRecords() {
    const records = new Map();
    let files = [];
    try {
        files = readdirSync(cacheDir);
    } catch {
        return records;
    }
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
            const parsed = JSON.parse(readFileSync(join(cacheDir, file), 'utf8'));
            if (parsed?.record !== undefined) records.set(file.slice(0, -5), parsed.record);
        } catch {
            // A record another process is mid-write on is simply not there yet.
        }
    }
    return records;
}

const records = cachedRecords();
/**
 * Unwrap one record's stored rows into the projection values `apply()` reads.
 *
 * The durable cache stores each row as `{ ver, seq, val }`; the projection a
 * live session exposes is that `val`, except for `tokenUsage`, whose value is
 * `{ totals, last }` and whose bucket set is `totals`. Passing the envelope
 * through would make every bucket set read as malformed and silently empty the
 * whole fold.
 * @param record - one cached session record.
 * @returns the projection values.
 */
function valuesOf(record) {
    const values = {};
    for (const [key, row] of Object.entries(record?.rows ?? {})) {
        if (row === null || typeof row !== 'object' || !('val' in row)) continue;
        if (key === 'tokenUsage') {
            if (row.val?.totals !== undefined) values.tokenUsage = row.val.totals;
            continue;
        }
        values[key] = row.val;
    }
    return values;
}

const attached = [];
for (const [id, record] of records) {
    const identity = record.identity ?? {};
    attached.push({
        id,
        header: { id, createdAt: identity.createdAt, isSeeded: identity.isSeeded === true, cwd: identity.cwd },
        record,
    });
}

const routes = new Map();
// The key is read here the way the running host resolves it — through the
// credentials service — and handed straight to the plugin. It is never
// printed, logged, or written.
const credentials = {
    async resolve(ref) {
        const stored = credentialFromStore(readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8'), ref);
        return stored === undefined ? undefined : { value: stored, source: 'store' };
    },
};
const ctx = {
    logger: () => ({ info() {}, warn(...args) { console.error('[warn]', ...args); }, error(...args) { console.error('[error]', ...args); } }),
    get: (name) => (name === 'sessions' ? { list: () => attached } : name === 'credentials' ? credentials : undefined),
    sessionProjections: {
        snapshot: (session) => ({ asOfSeq: 0, values: valuesOf(session.record) }),
        onChanged: () => () => {},
    },
    sessionPersistence: { list: async () => [] },
    sessionProjectionCache: {
        cachedSnapshot: (header) => {
            const record = records.get(header.id);
            return record === undefined ? undefined : { asOfSeq: 0, values: valuesOf(record) };
        },
    },
    webServer: {
        register(route) {
            routes.set(route.path, route);
            return () => routes.delete(route.path);
        },
    },
    effect(body) {
        body();
        return () => {};
    },
};

apply(ctx, {
    role: 'local',
    trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'], providerPatterns: ['deepseek'] }],
    sessionsDir,
    collectorToken: '',
    opencodeDbPath: join(DSH_HOME, 'no-such-opencode.db'),
    opencodeAuthPath: join(DSH_HOME, 'no-such-auth.json'),
    penAuthPath: join(DSH_HOME, 'no-such-pen-auth'),
    penSessionsDir: join(DSH_HOME, 'no-such-pen-sessions'),
    workbuddyModelsPath: join(DSH_HOME, 'no-such-wb-models.json'),
    workbuddyProjectsDir: join(DSH_HOME, 'no-such-wb-projects'),
});

// The tracked half is deliberately not awaited by the route handler, so the
// figure lands a moment after the first read.
const summary = routes.get('/token-ledger/summary');
const fakeResponse = () => ({
    statusCode: 0,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    flushHeaders() {},
    write() {},
    end(body) { this.body = body; },
    on() {},
});
const read = async () => {
    const res = fakeResponse();
    await summary.handler({ method: 'GET', url: '/token-ledger/summary', headers: {} }, res);
    return JSON.parse(res.body);
};

let payload;
for (let attempt = 0; attempt < 400; attempt += 1) {
    payload = await read();
    // The tracked half resolves the key and folds every log; wait for a key to
    // exist at all, then one more beat for the figure to settle.
    if (payload?.tracked?.keys?.length > 0 && payload.sessions.counted > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
}
await new Promise((resolve) => setTimeout(resolve, 250));
payload = await read();

const group = (value) => value.toLocaleString('en-US');
console.log(`month                ${payload.period.key}`);
console.log(`sessions             counted ${payload.sessions.counted}, live ${payload.sessions.live}, skipped-seeded ${payload.sessions.skippedSeeded}`);
console.log(`\nheadline (this key)  ${group(payload.month)}`);
console.log(`  key month          ${group(payload.tracked.keys[0]?.month ?? 0)}`);
console.log(`\nmachine row`);
console.log(`  本机 DSH (month)   ${group(payload.local.month)}`);
console.log(`  monthSource        ${payload.local.monthSource}`);
console.log(`  exact              ${payload.local.exact}   unattributed ${payload.local.unattributed}`);
console.log(`  all-time           ${group(payload.local.total)}`);

// The plugin owns intervals this harness has no disposer for; nothing is left
// to observe once the payload is printed.
process.exit(0);
