#!/usr/bin/env node
/**
 * Measure the `split` rule's shortfall against this machine's real data.
 *
 * Read-only diagnostic. Prints counts and fingerprinted-prefix facts only; it
 * never prints, logs, or writes a key.
 *
 * It answers one question: for every session whose `createdAt` precedes the
 * 1st and whose last prompt is inside the month, how many tokens do the session
 * logs show it spending *inside* the month? That number is what the current
 * `split` rule drops on the floor, and what counting it would add.
 *
 * Usage: node tools/measure-split.mjs [--month YYYY-MM]
 */
import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseOpencodeAuthKeys, resolveTrackedKeys } from '../lib/identity.js';
import { createScanState, listSessionLogs, parseBucketKey, scanSessionLog } from '../lib/attribution.js';
import { credentialFromStore } from './tracked-report.mjs';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
const totalOf = (buckets) => BUCKETS.reduce((sum, field) => sum + buckets[field], 0);
const group = (value) => value.toLocaleString('en-US');

/** The [start, end) of one calendar month in local time. */
function monthWindowOf(key) {
    const [year, month] = key.split('-').map(Number);
    return { start: new Date(year, month - 1, 1).getTime(), end: new Date(year, month, 1).getTime() };
}

/** Every projection-cache record, as `{ id, createdAt, lastPromptAt }`. */
function projectionRecords() {
    const dir = join(DSH_HOME, 'storages', 'session_projcache', 'sessions');
    const records = new Map();
    let files = [];
    try {
        files = readdirSync(dir);
    } catch {
        return records;
    }
    for (const file of files) {
        if (!file.endsWith('.json')) continue;
        let parsed;
        try {
            parsed = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        } catch {
            continue;
        }
        const record = parsed?.record;
        if (record === undefined) continue;
        const createdAt = record?.identity?.createdAt;
        const meta = record?.rows?.sessionListMetadata?.val;
        const usage = record?.rows?.tokenUsage?.val?.totals;
        records.set(file.slice(0, -'.json'.length), {
            createdAt: typeof createdAt === 'number' ? createdAt : undefined,
            lastPromptAt: typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : null,
            buckets: usage !== null && typeof usage === 'object' ? usage : undefined,
            seeded: record?.identity?.isSeeded === true,
        });
    }
    return records;
}

/** The ladder as shipped: projection only, split contributes zero. */
function currentContribution(session, period) {
    const billed = session.projected ?? 0;
    if (session.createdAt !== undefined && session.createdAt >= period.start) return { tokens: billed, how: 'born' };
    if (session.lastPromptAt === null) return { tokens: 0, how: 'idle' };
    if (typeof session.lastPromptAt === 'number' && session.lastPromptAt < period.start) return { tokens: 0, how: 'idle' };
    return { tokens: 0, how: 'split' };
}

/** The ladder with the log's own in-month figure folded in. */
function fixedContribution(session, period) {
    const billed = session.projected ?? 0;
    if (session.createdAt !== undefined && session.createdAt >= period.start) return { tokens: billed, how: 'born' };
    if (session.lastPromptAt === null) return { tokens: 0, how: 'idle' };
    if (typeof session.lastPromptAt === 'number' && session.lastPromptAt < period.start) return { tokens: 0, how: 'idle' };
    if (session.loggedMonth === undefined) return { tokens: 0, how: 'split' };
    return { tokens: session.loggedMonth, how: 'log' };
}

const monthKey = process.argv.includes('--month')
    ? process.argv[process.argv.indexOf('--month') + 1]
    : new Date().toISOString().slice(0, 7);
const period = { key: monthKey, ...monthWindowOf(monthKey) };

let rawKey = process.env.DEEPSEEK_API_KEY;
try {
    rawKey ??= credentialFromStore(readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8'), 'DEEPSEEK_API_KEY');
} catch {
    // No store: scan with no tracked keys, which still yields every owner's
    // buckets — the machine-wide figure is what the split rule governs.
}
const resolved = await resolveTrackedKeys({
    // The same lookup the deployed plugin uses, so "this key's share" and
    // "everyone's share" of one session can be told apart.
    trackKeys: rawKey === undefined ? [] : [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'], providerPatterns: ['deepseek'] }],
    credentials: rawKey === undefined ? undefined : { async resolve() { return { value: rawKey, source: 'local' }; } },
    env: {},
});
const trackedFingerprint = resolved.keys[0]?.fingerprint;
if (trackedFingerprint === undefined) console.error('(no key resolved: every bucket will read as unattributed)');

// Fold every log once, keeping each session's buckets under its own id.
const states = new Map();
for (const log of listSessionLogs({ sessionsDir: join(DSH_HOME, 'sessions') })) {
    const state = createScanState();
    scanSessionLog({ path: log.path, state, keys: resolved.keys });
    states.set(log.sessionId, state);
}

const records = projectionRecords();
const prefix = `${period.key}-`;
let splitCount = 0;
let splitUnknown = 0;
let splitMonthTokens = 0;
let idleCount = 0;
let bornCount = 0;
let bornMonthTokens = 0;
// The two candidate machine figures, accumulated side by side.
let currentMonth = 0;
let currentUnknown = 0;
let fixedMonth = 0;
let fixedUnknown = 0;
const detail = [];

for (const [id, record] of records) {
    const state = states.get(id);
    // What the log says this session spent inside the month, every owner, plus
    // the tracked key's own share of it.
    let loggedMonth;
    let trackedMonth = 0;
    let billed = 0;
    if (state !== undefined) {
        loggedMonth = 0;
        for (const [key, buckets] of Object.entries(state.buckets)) {
            const { owner, day } = parseBucketKey(key);
            const tokens = totalOf(buckets);
            billed += tokens;
            if (!day.startsWith(prefix)) continue;
            loggedMonth += tokens;
            if (owner === trackedFingerprint) trackedMonth += tokens;
        }
    }
    // The projection's per-session total, read straight from its own cache, so
    // the comparison uses the same figure the shipped ladder does.
    const projected = record.buckets === undefined ? undefined : totalOf(record.buckets);

    if (record.createdAt !== undefined && record.createdAt >= period.start) {
        bornCount += 1;
        bornMonthTokens += loggedMonth ?? 0;
    } else if (record.lastPromptAt !== null && record.lastPromptAt < period.start) {
        idleCount += 1;
    } else {
        splitCount += 1;
        if (loggedMonth === undefined) splitUnknown += 1;
        else splitMonthTokens += loggedMonth;
        detail.push({ id, loggedMonth, trackedMonth, projected, born: false, owners: [...new Set(Object.keys(state?.buckets ?? {}).map((key) => parseBucketKey(key).owner))].map((owner) => owner.slice(0, 8)) });
    }

    // Rule by rule, the ladder as shipped versus the ladder with the log folded
    // in. Absent a log, both fall back to the projection.
    const current = currentContribution({ createdAt: record.createdAt, lastPromptAt: record.lastPromptAt, projected }, period);
    const fixed = fixedContribution({ createdAt: record.createdAt, lastPromptAt: record.lastPromptAt, projected, loggedMonth }, period);
    currentMonth += current.tokens;
    if (current.how === 'split') currentUnknown += 1;
    fixedMonth += fixed.tokens;
    if (fixed.how === 'split') fixedUnknown += 1;
}

console.log(`month                ${period.key}`);
console.log(`projection records   ${records.size}`);
console.log(`session logs         ${states.size}`);
console.log(`\nborn this month      ${bornCount} session(s)  (projection-derived: ${group(bornMonthTokens)} logged in-month)`);
console.log(`idle (pre-month)     ${idleCount} session(s)`);
console.log(`SPLIT                ${splitCount} session(s)`);
console.log(`  of which no log    ${splitUnknown}`);
console.log(`  in-month tokens    ${group(splitMonthTokens)}   <- what the split rule currently drops`);
console.log(`  this key's share   ${group(detail.reduce((sum, row) => sum + (row.trackedMonth ?? 0), 0))}`);
console.log(`\nmachine month figure`);
console.log(`  as shipped         ${group(currentMonth).padStart(14)}   (${currentUnknown} unattributable session(s))`);
console.log(`  with the log       ${group(fixedMonth).padStart(14)}   (${fixedUnknown} unattributable session(s))`);
console.log(`  difference         ${group(fixedMonth - currentMonth).padStart(14)}`);
console.log(`\nper split session`);
for (const row of detail.sort((left, right) => (right.loggedMonth ?? 0) - (left.loggedMonth ?? 0)).slice(0, 12)) {
    const shown = row.loggedMonth === undefined ? '—' : group(row.loggedMonth);
    console.log(`  ${row.id.padEnd(44)} log ${String(shown).padStart(14)}  key ${String(row.trackedMonth === undefined ? '—' : group(row.trackedMonth)).padStart(13)}  proj ${String(row.projected === undefined ? '—' : group(row.projected)).padStart(13)}  owners ${row.owners.join(',')}`);
}
