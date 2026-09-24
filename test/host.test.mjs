/**
 * Host-half checks for dsh-month-tokens.
 *
 * Runs the real `apply()` against a fake service set, drives the real route
 * handler, and pins the month-attribution ladder — the part of this plugin
 * that cannot be derived from a cumulative figure alone. No DSH boot, no
 * network, no dependencies.
 *
 * Usage: node test/host.test.mjs
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fakeKey } from './fake-key.mjs';
import zlib from 'node:zlib';
import {
  apply,
  inject,
  activityMonthTokens,
  monthContribution,
  monthWindow,
  readOpencodeAttribution,
  readOpencodeMonth,
  readPenAttribution,
  readPenMonth,
  readWorkbuddyAttribution,
  readWorkbuddyMonth,
} from '../lib/index.js';
import { fingerprintOfKey } from '../lib/identity.js';

// Absent on Node < 22.5 and on builds without the flag. That is a state this
// plugin claims to survive, so the suite must run there rather than assume it.
const sqlite = await import('node:sqlite').catch(() => undefined);
const hasSqlite = sqlite !== undefined;

// `node:sqlite` is experimental and announces itself on every import; the test
// output should not read as if something went wrong.
{
  const emit = process.emit;
  process.emit = function (name, data, ...rest) {
    if (name === 'warning' && data?.name === 'ExperimentalWarning' && /SQLite/.test(data.message)) return false;
    return emit.call(this, name, data, ...rest);
  };
}

/** A fake `ServerResponse` capturing status, headers, and body. */
function fakeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    chunks: [],
    closed: undefined,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    flushHeaders() {},
    write(chunk) {
      this.chunks.push(chunk);
    },
    end(body) {
      this.body = body;
      this.gotEnd = true;
    },
    on(event, listener) {
      if (event === 'close') this.closed = listener;
    },
  };
}

/** A fake `IncomingMessage`. */
function fakeRequest(url, method = 'GET') {
  return { url, method, on() {} };
}

/**
 * Build a fake host context plus its observable seams.
 * @param options - attached sessions, stored headers, and cached rows.
 * @returns the context, registered routes, a change-feed emitter, and a disposer.
 */
function makeHost({ attached = [], stored = [], cache = {} } = {}) {
  const routes = new Map();
  const listeners = new Set();
  const pending = [];
  const metaOf = (lastPromptAt) => ({ blank: false, lastPromptAt });
  const valuesOf = (session) => {
    const values = { tokenUsage: session.usage };
    values.sessionListMetadata = session.meta ?? metaOf(session.lastPromptAt ?? session.header?.createdAt ?? null);
    if (session.activity !== undefined) values.contextActivity = session.activity;
    return values;
  };
  const ctx = {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    get: (name) => (name === 'sessions' ? { list: () => attached } : undefined),
    sessionProjections: {
      snapshot: (session) => ({ asOfSeq: 0, values: valuesOf(session) }),
      onChanged(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    sessionPersistence: { list: async () => stored.map((header) => ({ header })) },
    sessionProjectionCache: {
      cachedSnapshot: (header) => {
        const row = cache[header.id];
        if (row === undefined) return undefined;
        const values = {
          tokenUsage: row.usage ?? row,
          sessionListMetadata: row.meta ?? metaOf(row.lastPromptAt ?? header.createdAt ?? null),
        };
        if (row.activity !== undefined) values.contextActivity = row.activity;
        return { asOfSeq: 0, values };
      },
    },
    webServer: {
      register(route) {
        routes.set(route.path, route);
        return () => routes.delete(route.path);
      },
    },
    effect(body) {
      pending.push(body());
      return () => {};
    },
  };
  return {
    ctx,
    // Never the developer's own files: every test states its own fixture or
    // none, for all three third-party readers. The paths must not exist —
    // `absent` is the state a test that does not care about a reader expects,
    // and pointing them at a real store would make the suite depend on the
    // machine it runs on.
    config: {
      opencodeDbPath: join(tmpdir(), 'dsh-month-tokens-no-such-opencode.db'),
      opencodeAuthPath: join(tmpdir(), 'dsh-month-tokens-no-such-opencode-auth.json'),
      penAuthPath: join(tmpdir(), 'dsh-month-tokens-no-such-pen-auth'),
      penSessionsDir: join(tmpdir(), 'dsh-month-tokens-no-such-pen-sessions'),
      workbuddyModelsPath: join(tmpdir(), 'dsh-month-tokens-no-such-workbuddy-models.json'),
      workbuddyProjectsDir: join(tmpdir(), 'dsh-month-tokens-no-such-workbuddy-projects'),
    },
    routes,
    emit: (session, key, value) => {
      for (const listener of listeners) listener(session, key, value);
    },
    dispose: () => {
      for (const disposer of pending) if (typeof disposer === 'function') disposer();
    },
  };
}

/** Read one route's JSON body. */
async function readSummary(routes) {
  const route = routes.get('/token-ledger/summary');
  assert.ok(route !== undefined, 'summary route must be registered');
  const res = fakeResponse();
  await route.handler(fakeRequest('/token-ledger/summary'), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  return JSON.parse(res.body);
}

/**
 * Build a throwaway opencode-shaped database.
 * @param rows - `{ time, data }` message rows.
 * @returns the database path, plus a disposer for the temp directory.
 */
function fixtureDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-test-'));
  const path = join(dir, 'opencode.db');
  const { DatabaseSync } = require_sqlite();
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
  const insert = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  rows.forEach((row, index) => {
    insert.run(`m${String(index)}`, 's1', row.time, row.time, JSON.stringify(row.data));
  });
  db.close();
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The synchronous sqlite module, for building fixtures. */
function require_sqlite() {
  return sqlite;
}

/** One assistant message's `data` blob, as opencode writes it. */
const ocMessage = (provider, tokens) => ({ role: 'assistant', providerID: provider, tokens });

/**
 * Poll until the asynchronous opencode read has settled.
 *
 * Its arrival republishes — correctly, so an open panel picks the row up — but
 * that means a revision read before it lands is not yet final.
 * @param routes - the registered routes.
 * @returns the settled summary.
 */
async function settled(routes) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const summary = await readSummary(routes);
    if (summary.tools?.opencode?.state !== 'loading') return summary;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('the opencode read never settled');
}

/** Total tokens in one bucket set. */
const sumOf = (set) => set.uncachedInputTokens + set.outputTokens + set.cacheReadTokens + set.cacheWriteTokens;

const buckets = (uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens) => ({
  uncachedInputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

/** `YYYY-MM-DD` for a day inside the month `offset` months from now. */
function dayKey(offset, day) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  date.setDate(day);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${month}-${String(day).padStart(2, '0')}`;
}

/** An epoch inside the month `offset` months from now. */
function monthMoment(offset, day = 10) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(1);
  date.setMonth(date.getMonth() + offset);
  date.setDate(day);
  return date.getTime();
}

// ---------------------------------------------------------------- injection
assert.deepEqual(inject, ['webServer', 'sessionPersistence', 'sessionProjections', 'sessionProjectionCache']);

// ------------------------------------------------------------- the period
{
  const now = new Date(2026, 8, 24, 12, 0, 0).getTime();
  const window = monthWindow(now);
  assert.equal(window.key, '2026-09');
  assert.equal(new Date(window.start).getDate(), 1, 'the period starts on the 1st');
  assert.equal(new Date(window.start).getHours(), 0, 'at local midnight');
  assert.equal(new Date(window.end).getDate(), 25, 'and runs through tomorrow');
  assert.ok(window.start <= now && now < window.end);

  // The last day of a month ends exactly at the next month's first instant.
  const monthEnd = monthWindow(new Date(2026, 8, 30, 23, 59, 0).getTime());
  assert.equal(monthEnd.key, '2026-09');
  assert.equal(new Date(monthEnd.end).getMonth(), 9, 'the 30th rolls into October');
  assert.equal(new Date(monthEnd.end).getDate(), 1);
  assert.equal(monthWindow(new Date(2026, 9, 1, 0, 0, 1).getTime()).key, '2026-10', 'and the counter has turned over');
}

// ------------------------------------------------------- day-ledger summer
{
  assert.equal(activityMonthTokens({ days: { '2026-09-01': { tokens: 5 }, '2026-09-30': { tokens: 7 } } }, '2026-09'), 12);
  assert.equal(activityMonthTokens({ days: { '2026-08-31': { tokens: 999 } } }, '2026-09'), 0, 'a ledger with nothing this month answers zero, not "no ledger"');
  assert.equal(activityMonthTokens({ days: { '2026-09-01': { bad: 1 } } }, '2026-09'), 0, 'a malformed day contributes nothing but the ledger still exists');
  assert.equal(activityMonthTokens(undefined, '2026-09'), undefined, 'no ledger is a distinct answer from an empty one');
  assert.equal(activityMonthTokens({ days: 'nope' }, '2026-09'), undefined);
  assert.equal(activityMonthTokens({ days: ['nope'] }, '2026-09'), undefined);
  assert.equal(activityMonthTokens({}, '2026-09'), undefined);
}

// ---------------------------------------------- the month-attribution ladder
{
  const period = monthWindow(Date.now());
  const before = period.start - 86_400_000;

  // 1. A day ledger is authoritative, even when it answers zero.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: before, lastPromptAt: Date.now(), days: { days: { [`${period.key}-02`]: { tokens: 40 } } } }, period),
    { tokens: 40, how: 'ledger' },
  );

  // 2. Born this month: everything it ever spent is this month's.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: period.start + 1000, lastPromptAt: Date.now() }, period),
    { tokens: 500, how: 'born' },
  );

  // 3. Born earlier, last prompted earlier: it spent nothing this month.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: before, lastPromptAt: before }, period),
    { tokens: 0, how: 'idle' },
  );
  // A session that has never seen a prompt is idle too.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: before, lastPromptAt: null }, period),
    { tokens: 0, how: 'idle' },
  );

  // 4. Born earlier AND prompted this month: the unavoidable split.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: before, lastPromptAt: Date.now() }, period),
    { tokens: 0, how: 'split' },
  );
  // Unknown is NOT the same fact as "no prompt yet", and must not pass as exact.
  assert.deepEqual(
    monthContribution({ buckets: buckets(500, 0, 0, 0), createdAt: before }, period),
    { tokens: 0, how: 'split' },
  );
}

// ------------------------------------------- local aggregation, both paths
{
  const now = Date.now();
  const host = makeHost({
    attached: [{ id: 'live-1', header: { createdAt: now }, usage: buckets(100, 20, 900, 0) }],
    stored: [
      { id: 'live-1', isSeeded: false, createdAt: now },
      { id: 'cold-1', isSeeded: false, createdAt: now },
      { id: 'cold-2', isSeeded: false, createdAt: now },
      { id: 'seeded-1', isSeeded: true, createdAt: now },
    ],
    cache: { 'cold-1': buckets(7, 3, 40, 5), 'cold-2': buckets(1, 1, 1, 1) },
  });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const summary = await readSummary(host.routes);
  assert.deepEqual(summary.totals, buckets(108, 24, 941, 6));
  assert.equal(summary.sessions.counted, 3, 'live + two cold sessions');
  assert.equal(summary.sessions.live, 1);
  assert.equal(summary.sessions.skippedSeeded, 1, 'the forked session is reported, never guessed');
  assert.equal(summary.period.kind, 'month');
  assert.equal(summary.month, 1079, 'every session was created this month, so the month equals the whole');
  assert.equal(summary.local.monthSource, 'born');
  assert.equal(summary.local.exact, true);
  assert.equal(summary.local.unattributed, 0);
  host.dispose();
}

// ------------------------------- a spanning session is reported, not zeroed
{
  const now = Date.now();
  const host = makeHost({
    attached: [
      { id: 'born', header: { createdAt: now }, usage: buckets(300, 0, 0, 0) },
      { id: 'spanning', header: { createdAt: monthMoment(-2) }, lastPromptAt: now, usage: buckets(9_000_000, 0, 0, 0) },
      { id: 'old-idle', header: { createdAt: monthMoment(-2) }, lastPromptAt: monthMoment(-1), usage: buckets(5000, 0, 0, 0) },
    ],
    stored: [],
  });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const summary = await readSummary(host.routes);
  assert.equal(summary.local.monthSource, 'mixed', 'the ladder mixes rules, and says so');
  assert.equal(summary.local.exact, false);
  assert.equal(summary.local.unattributed, 1, 'the unknowable session is counted, not hidden');
  assert.equal(summary.month, 300, 'born this month contributes; the idle one is a confirmed zero');
  assert.equal(summary.local.total, 9_005_300, 'and the all-time figure still includes everything');
  host.dispose();
}

// --------------------------- a day ledger resolves the spanning session
{
  const now = Date.now();
  const host = makeHost({
    attached: [
      {
        id: 'spanning',
        header: { createdAt: monthMoment(-2) },
        lastPromptAt: now,
        usage: buckets(9_000_000, 0, 0, 0),
        activity: { days: { [dayKey(-2, 5)]: { tokens: 8_900_000 }, [dayKey(0, 2)]: { tokens: 100_000 } } },
      },
    ],
    stored: [],
  });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const summary = await readSummary(host.routes);
  assert.equal(summary.local.monthSource, 'ledger');
  assert.equal(summary.local.exact, true);
  assert.equal(summary.local.unattributed, 0);
  assert.equal(summary.month, 100_000, 'only the days inside the month count');
  host.dispose();
}

// --------------------------- a day ledger on a cold session counts too
{
  const host = makeHost({
    stored: [{ id: 'cold-1', isSeeded: false, createdAt: monthMoment(-3) }],
    cache: {
      'cold-1': {
        usage: buckets(9000, 0, 0, 0),
        lastPromptAt: Date.now(),
        activity: { days: { [dayKey(-3, 5)]: { tokens: 8940 }, [dayKey(0, 2)]: { tokens: 60 } } },
      },
    },
  });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const summary = await readSummary(host.routes);
  assert.equal(summary.month, 60, 'a cold session contributes only its days inside the month');
  assert.equal(summary.local.total, 9000);
  host.dispose();
}

// ------------------------------------------------------ live change feed
{
  const session = { id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(10, 1, 0, 0) };
  const host = makeHost({ attached: [session], stored: [] });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const first = await readSummary(host.routes);
  assert.equal(first.month, 11);

  // A settled turn moves the month with no rescan and no polling.
  host.emit(session, 'tokenUsage', buckets(400, 55, 0, 0));
  const second = await readSummary(host.routes);
  assert.equal(second.month, 455);
  assert.ok(second.revision > first.revision, 'revision advances on change');

  // The list metadata is a second pushed key, and it must not wipe the total.
  host.emit(session, 'sessionListMetadata', { blank: false, lastPromptAt: Date.now() });
  const third = await readSummary(host.routes);
  assert.equal(third.month, 455, 'a sibling key update keeps the bucket total');

  // An unrelated key must not disturb the fold.
  host.emit(session, 'title', 'ignored');
  assert.equal((await readSummary(host.routes)).revision, third.revision);

  // A malformed value is refused rather than poisoning the sum.
  host.emit(session, 'tokenUsage', { uncachedInputTokens: 'lots' });
  assert.equal((await readSummary(host.routes)).month, 455);
  host.dispose();
}

// ------------------- a spanning session resolves once its idleness is known
{
  const session = { id: 'live-1', header: { createdAt: monthMoment(-2) }, lastPromptAt: Date.now(), usage: buckets(5000, 0, 0, 0) };
  const host = makeHost({ attached: [session], stored: [] });
  apply(host.ctx, host.config);
  await settled(host.routes);
  assert.equal((await readSummary(host.routes)).local.unattributed, 1, 'prompted this month: unknowable');

  host.emit(session, 'sessionListMetadata', { blank: false, lastPromptAt: monthMoment(-2) });
  const summary = await readSummary(host.routes);
  assert.equal(summary.local.unattributed, 0, 'once its last prompt is known to predate the month, it resolves');
  assert.equal(summary.local.monthSource, 'idle');
  host.dispose();
}

// ------------------------------------------------------- streaming route
{
  const session = { id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(5, 5, 0, 0) };
  const host = makeHost({ attached: [session], stored: [] });
  apply(host.ctx, host.config);
  await settled(host.routes);
  await readSummary(host.routes);

  const route = host.routes.get('/token-ledger/stream');
  assert.ok(route !== undefined, 'stream route must be registered');
  const res = fakeResponse();
  await route.handler(fakeRequest('/token-ledger/stream'), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.chunks[0], /^retry: 3000\nevent: ledger\ndata: \{/);

  const before = res.chunks.length;
  host.emit(session, 'tokenUsage', buckets(50, 5, 0, 0));
  assert.equal(res.chunks.length, before + 1, 'an open stream receives the new frame');
  assert.equal(JSON.parse(res.chunks.at(-1).replace(/^event: ledger\ndata: /, '').trim()).month, 55);

  // A client disconnect releases its seat.
  res.closed();
  const afterClose = res.chunks.length;
  host.emit(session, 'tokenUsage', buckets(60, 5, 0, 0));
  assert.equal(res.chunks.length, afterClose, 'a dropped stream stops receiving frames');
  host.dispose();
}

// ------------------------------------------------------- method + empty
{
  const host = makeHost({ attached: [], stored: [] });
  apply(host.ctx, host.config);
  await settled(host.routes);
  const route = host.routes.get('/token-ledger/summary');
  const rejected = fakeResponse();
  await route.handler(fakeRequest('/token-ledger/summary', 'POST'), rejected);
  assert.equal(rejected.statusCode, 405);
  assert.equal(rejected.headers.allow, 'GET, HEAD');

  const summary = await readSummary(host.routes);
  assert.deepEqual(summary.totals, buckets(0, 0, 0, 0));
  assert.equal(summary.sessions.counted, 0);
  assert.equal(summary.month, 0);
  assert.equal(summary.local.monthSource, 'none', 'no sessions means no derivation to claim');
  host.dispose();
}

// -------------------------- opencode: degradation, asserted on every runtime
{
  const window = monthWindow(Date.now());
  assert.deepEqual(
    await readOpencodeMonth({ dbPath: 'unused', providers: ['deepseek'], monthStart: window.start, sqliteLoader: async () => undefined }),
    { state: 'unavailable', message: 'node:sqlite is not available in this runtime' },
    'a runtime without node:sqlite must say so, not report a zero',
  );
  assert.equal(
    (await readOpencodeMonth({ dbPath: join(tmpdir(), 'no-such-opencode-db'), providers: ['deepseek'], monthStart: window.start })).state,
    'absent',
    'a missing database is a stated fact',
  );
  const broken = { DatabaseSync: function DatabaseSync() { throw new Error('database is locked'); } };
  assert.equal(
    (await readOpencodeMonth({ dbPath: import.meta.filename, providers: ['deepseek'], monthStart: window.start, sqliteLoader: async () => broken })).state,
    'error',
    'an open failure is reported, never swallowed',
  );
}

// ------------------------------------------------ opencode: the reader
if (hasSqlite) {
  const now = Date.now();
  const inMonth = now;
  const lastMonth = (() => {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return d.getTime();
  })();
  const db = fixtureDb([
    { time: inMonth, data: ocMessage('deepseek', { input: 100, output: 10, reasoning: 5, cache: { read: 900, write: 1 }, total: 1016 }) },
    { time: inMonth, data: ocMessage('deepseek', { input: 7, output: 2, reasoning: 3, cache: { read: 0, write: 0 }, total: 12 }) },
    { time: inMonth, data: ocMessage('google', { input: 999_999, output: 1, reasoning: 0, cache: { read: 0, write: 0 }, total: 1_000_000 }) },
    { time: lastMonth, data: ocMessage('deepseek', { input: 888_888, output: 0, reasoning: 0, cache: { read: 0, write: 0 }, total: 888_888 }) },
    { time: inMonth, data: { role: 'user' } },
  ]);
  try {
    const window = monthWindow(now);
    const result = await readOpencodeMonth({ dbPath: db.path, providers: ['deepseek'], monthStart: window.start });
    assert.equal(result.state, 'ok');
    assert.equal(result.messages, 2, 'only assistant messages from the month and the named provider count');
    assert.deepEqual(result.totals, buckets(107, 20, 900, 1), 'reasoning is folded into output; cache read and write stay separate');
    assert.equal(result.totals.uncachedInputTokens + result.totals.outputTokens + result.totals.cacheReadTokens + result.totals.cacheWriteTokens, 1028);
    assert.ok(result.fetchedAt > 0);

    // A different provider filter sees a different slice.
    const google = await readOpencodeMonth({ dbPath: db.path, providers: ['google'], monthStart: window.start });
    assert.equal(google.messages, 1);
    assert.equal(google.totals.uncachedInputTokens, 999_999);
  } finally {
    db.cleanup();
  }
}

// --------------------------------------- opencode: schema drift is not a zero
if (hasSqlite) {
  const dir = mkdtempSync(join(tmpdir(), 'token-ledger-drift-'));
  const path = join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(path);
  db.exec('CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)');
  // Same table, no `tokens` anywhere: the query succeeds and sums to nothing.
  db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('m0', 's1', Date.now(), Date.now(), JSON.stringify({ role: 'assistant', providerID: 'deepseek' }));
  db.close();
  try {
    const result = await readOpencodeMonth({ dbPath: path, providers: ['deepseek'], monthStart: monthWindow(Date.now()).start });
    assert.equal(result.state, 'drift', 'a readable-but-tokenless schema must not pass as a real zero');
    assert.equal(result.messages, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ----------------------------- opencode: folded into the headline and split out
if (hasSqlite) {
  const now = Date.now();
  const db = fixtureDb([{ time: now, data: ocMessage('deepseek', { input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 }, total: 500 }) }]);
  const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: now }, usage: buckets(1000, 0, 0, 0) }], stored: [] });
  host.config.opencodeDbPath = db.path;
  try {
    apply(host.ctx, host.config);
    const summary = await settled(host.routes);
    assert.equal(summary.tools.opencode.state, 'ok');
    assert.equal(summary.tools.opencode.messages, 1);
    assert.equal(summary.local.month, 1000, 'the DSH share stays its own number');
    assert.equal(summary.month, 1500, 'and the headline adds opencode on top');
    assert.equal(summary.local.total, 1000, 'the all-time figure remains DSH-only');
  } finally {
    host.dispose();
    db.cleanup();
  }
}

// ------------------------- opencode: a missing database is reported, not zero
{
  const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(1000, 0, 0, 0) }], stored: [] });
  apply(host.ctx, host.config);
  const summary = await settled(host.routes);
  assert.equal(summary.tools.opencode.state, 'absent', 'an absent database is a stated fact, not a silent 0');
  assert.equal(summary.month, 1000, 'and the headline falls back to the DSH share');
  host.dispose();
}


// ══════════════════════════════════════════════ the cross-machine half

/** Whether this runtime can build the zstd frames a real session log uses. */
const hasZstd = typeof zlib.zstdCompressSync === 'function';

/**
 * Build a throwaway session-log tree holding one real zstd-framed log.
 *
 * Real frames rather than a stub: the whole point of the tracked fold is that
 * it reads the durable log the projection discards, so a fixture that did not
 * exercise the frame reader would test nothing that ships.
 * @param events - the log events to write, in order.
 * @returns the sessions directory and a disposer.
 */
function fixtureSessionLog(events) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tokens-logs-'));
  const sessionDir = join(dir, '--workspace--', 'session-fixture');
  mkdirSync(sessionDir, { recursive: true });
  const body = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
  writeFileSync(join(sessionDir, 'session.v3.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * A throwaway directory holding one or more JSONL records files.
 * @param prefix - the temp-directory prefix.
 * @param files - `{ relativePath: records }`.
 * @returns the directory, plus a disposer.
 */
function fixtureJsonl(prefix, files) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  for (const [relative, records] of Object.entries(files)) {
    const full = join(dir, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One Pen assistant message, shaped like pi-ai's. */
const penLine = (timestamp, usage, provider = 'deepseek', model = 'deepseek-v4-flash-vision-exp') => ({
  type: 'message',
  message: { role: 'assistant', provider, model, timestamp, usage },
});

/** One WorkBuddy settlement, shaped like its `function_call` record. */
const wbLine = (timestamp, rawUsage, requestModelId = 'custom-local:deepseek-v4-flash', model = 'deepseek-flash') => ({
  type: 'function_call',
  timestamp,
  providerData: { requestModelId, model, rawUsage },
});

/**
 * One WorkBuddy event that carries `providerData` but no usage envelope.
 *
 * Measured on the real store: `function_call_result` (27) and `reasoning` (15)
 * carry the same `providerData` as the settlement they belong to. They are the
 * same request, not another one, and counting them would multiply the month.
 */
const wbEventLine = (timestamp, requestModelId = 'custom-local:deepseek-v4-flash') => ({
  type: 'function_call_result',
  timestamp,
  providerData: { requestModelId, model: 'deepseek-flash' },
});

/** An empty directory usable as a DSH home or a sessions root. */
function fixtureDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Run a body with environment overrides, restoring exactly what was there.
 *
 * The tracked half reads `process.env` for credentials on purpose (a profile
 * without a credential service resolves that way), so a test that exercises
 * resolution has to own the environment for its duration.
 * @param overrides - `{ NAME: value }`; `undefined` deletes the name.
 * @param body - the async body to run.
 * @returns whatever the body returned.
 */
async function withEnv(overrides, body) {
  const saved = new Map();
  for (const [name, value] of Object.entries(overrides)) {
    saved.set(name, Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : undefined);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/**
 * Poll the published summary until a predicate accepts it.
 *
 * The tracked half is deliberately not awaited by the route handler — a panel
 * must never wait on a log scan — so its figures land a moment after the first
 * request rather than during it.
 * @param routes - the registered routes.
 * @param predicate - returns falsy to keep waiting.
 * @param what - a description for the timeout message.
 * @returns the accepted summary.
 */
async function waitFor(routes, predicate, what) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const summary = await readSummary(routes);
    if (predicate(summary)) return summary;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Today's local day key, the way the log fold spells it. */
function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// ------------------- no tracking configured reads no log and adds no keys
{
  const log = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'm', contextWindow: 1 } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 5 } } },
  ]);
  const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(100, 20, 900, 0) }], stored: [] });
  // A sessions directory IS configured and does hold a log — so an empty
  // `uncovered` below is proof the scan was skipped, not proof it found
  // nothing. With no tracked key there is no question to ask of a log, and
  // reading 20MB to answer nothing is the behaviour this pins.
  host.config.sessionsDir = log.dir;
  try {
    apply(host.ctx, host.config);
    const summary = await settled(host.routes);
    assert.equal(summary.month, 1020, 'the projection headline is untouched');
    assert.deepEqual(summary.local, {
      total: 1020,
      month: 1020,
      monthSource: 'born',
      exact: true,
      unattributed: 0,
    }, 'the local section keeps its exact pre-existing shape');
    assert.deepEqual(summary.tracked.keys, [], 'nothing is tracked by default');
    assert.deepEqual(summary.tracked.uncovered, [], 'and no log was read to discover uncovered routes');
    assert.deepEqual(summary.tracked.failures, []);
    assert.equal(summary.tracked.coverage, 'dsh+opencode+pen+workbuddy', 'the coverage line names every reader that ships');
    assert.equal(summary.tracked.role, 'local');
    assert.equal(summary.tracked.collector.state, 'off', 'no listener by default');
    assert.equal(summary.tracked.collector.instances, 1, 'a non-aggregating role sees exactly one instance: itself');
    assert.equal(summary.tracked.reporter.state, 'off', 'and no reports');
  } finally {
    host.dispose();
    log.cleanup();
  }
}

// ---------------------------------- a resolvable key is attributed by day
if (!hasZstd) {
  console.log('host: cross-machine fixtures skipped (zstd unavailable)');
} else {
  const KEY = fakeKey(1);
  const expectedShort = fingerprintOfKey(KEY).fingerprint.slice(0, 8);
  const log = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1000 } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 700, outputTokens: 50, cacheReadTokens: 3000 } } },
    // A plugin's own route, resolving the same credential: the route name is
    // not the key, and a matcher that assumed it was would drop this event.
    { type: 'request/context', time: Date.now(), data: { provider: 'vision-toolkit-deepseek-official', model: 'deepseek-v4-flash', contextWindow: 1000 } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 2, step: 1, usage: { inputTokens: 200, outputTokens: 10 } } },
  ]);
  const home = fixtureDir('dsh-tokens-home-');
  const config = () => ({
    trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official', 'vision-toolkit-deepseek-official'] }],
    sessionsDir: log.dir,
    collectorToken: '',
  });
  try {
    await withEnv({ DEEPSEEK_API_KEY: KEY, DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(1000, 0, 0, 0) }], stored: [] });
      Object.assign(host.config, config());
      apply(host.ctx, host.config);
      const summary = await waitFor(host.routes, (s) => s.tracked.keys.length > 0 && s.tracked.keys[0].month > 0, 'the tracked key');
      const key = summary.tracked.keys[0];
      assert.equal(key.short, expectedShort, 'the short fingerprint is the hash of the key, not its name');
      assert.equal(key.ref, 'DEEPSEEK_API_KEY');
      assert.deepEqual(key.providers, ['deepseek-official', 'vision-toolkit-deepseek-official']);
      assert.equal(key.month, 3960, 'both routes land in one bucket: 750 + 210 this month');
      assert.deepEqual(key.days[todayKey()], buckets(900, 60, 3000, 0), 'attributed to the event day, not the scan day');
      assert.deepEqual(
        key.models,
        { 'deepseek-v4-pro': buckets(700, 50, 3000, 0), 'deepseek-v4-flash': buckets(200, 10, 0, 0) },
        'the model split is this month, alongside an all-time total',
      );
      assert.equal(key.instances.length, 1, 'a local-only role knows one instance: itself');
      assert.equal(summary.tracked.coverage, 'dsh+opencode+pen+workbuddy', 'the coverage line names every reader that ships');
      assert.equal(summary.tracked.failures.length, 0);
      // The projection half is untouched by any of this.
      assert.equal(summary.local.month, 1000);
      assert.equal(summary.month, 1000, 'opencode is absent here, so the headline is the DSH share');
      assert.equal(summary.tracked.collector.state, 'off');

      // A second process on this machine must agree on who it is: an identity
      // that moved per boot would make an aggregator count one machine twice.
      const second = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(1000, 0, 0, 0) }], stored: [] });
      Object.assign(second.config, config());
      apply(second.ctx, second.config);
      try {
        const again = await waitFor(second.routes, (s) => s.tracked.keys[0]?.instances.length === 1, 'the second instance id');
        assert.equal(again.tracked.keys[0].instances[0].instance, key.instances[0].instance, 'the instance id is stable across processes');
      } finally {
        second.dispose();
      }
      host.dispose();
    });
  } finally {
    log.cleanup();
    home.cleanup();
  }
}

// --------------------------------------- credentials and refs that cannot resolve
{
  const home = fixtureDir('dsh-tokens-home-');
  const sessions = fixtureDir('dsh-tokens-empty-');
  try {
    await withEnv({ DEEPSEEK_API_KEY: undefined, DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [], stored: [] });
      host.config.trackKeys = ['DEEPSEEK_API_KEY', 'NOT_A_REAL_REF_ANYWHERE'];
      host.config.sessionsDir = sessions.dir;
      host.config.collectorToken = '';
      apply(host.ctx, host.config);
      const summary = await waitFor(host.routes, (s) => s.tracked.failures.length === 2, 'both failures');
      assert.deepEqual(
        summary.tracked.failures.map((failure) => [failure.ref, failure.reason]),
        [['DEEPSEEK_API_KEY', 'missing'], ['NOT_A_REAL_REF_ANYWHERE', 'missing']],
        'a configured key that cannot be resolved is reported, never folded in as zero',
      );
      assert.deepEqual(summary.tracked.keys, [], 'and it contributes no bucket');
      host.dispose();
    });
  } finally {
    sessions.cleanup();
    home.cleanup();
  }
}

// ------------------- an aggregator with no token refuses to listen at all
{
  const home = fixtureDir('dsh-tokens-home-');
  try {
    await withEnv({ DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(42, 0, 0, 0) }], stored: [] });
      host.config.role = 'aggregator';
      host.config.collectorToken = '';
      // Port 0 would let the OS hand out a free port, so a listener that
      // started anyway would be invisible in the status — which is exactly
      // what the missing `port` below rules out.
      host.config.collectorPort = 0;
      apply(host.ctx, host.config);
      const summary = await settled(host.routes);
      assert.equal(summary.tracked.collector.state, 'noToken', 'a tokenless aggregator says so');
      assert.equal('port' in summary.tracked.collector, false, 'and never bound a port');
      assert.equal(summary.tracked.role, 'aggregator');
      assert.equal(summary.tracked.reporter.state, 'off', 'an aggregator does not report unless told to');
      assert.equal(summary.tracked.collector.instances, 0, 'the store is empty, and says zero rather than nothing');
      assert.equal(summary.month, 42, 'the projection half still works');
      host.dispose();
    });
  } finally {
    home.cleanup();
  }
}

// ---------------- an unresolved fingerprint does not disturb the other halves
if (!hasSqlite) {
  console.log('host: opencode failure-isolation check skipped (no node:sqlite)');
} else {
  const home = fixtureDir('dsh-tokens-home-');
  const sessions = fixtureDir('dsh-tokens-empty-');
  const db = fixtureDb([
    { time: Date.now(), data: ocMessage('deepseek', { input: 400, output: 100, reasoning: 0, cache: { read: 0, write: 0 }, total: 500 }) },
  ]);
  try {
    await withEnv({ DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: undefined, NO_SUCH_KEY_ANYWHERE: undefined }, async () => {
      const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(1000, 0, 0, 0) }], stored: [] });
      host.config.opencodeDbPath = db.path;
      host.config.trackKeys = ['NO_SUCH_KEY_ANYWHERE'];
      host.config.sessionsDir = sessions.dir;
      host.config.collectorToken = '';
      apply(host.ctx, host.config);
      // Both halves must have settled before the assertions below can mean
      // anything: the failure line arrives on the tracked cycle, the opencode
      // figure on its own poll.
      const summary = await waitFor(
        host.routes,
        (s) => s.tracked.failures.length > 0 && s.tools.opencode.state !== 'loading',
        'the resolution failure and the opencode poll',
      );
      assert.equal(summary.tracked.failures[0].reason, 'missing');
      // The three pre-existing outputs must be exactly what they were before
      // this half existed.
      assert.equal(summary.local.month, 1000, 'the DSH share is untouched');
      assert.equal(summary.local.total, 1000, 'and so is the all-time figure');
      assert.equal(summary.tools.opencode.state, 'ok');
      assert.equal(summary.month, 1500, 'the headline still adds opencode');
      assert.deepEqual(summary.tracked.keys, [], 'a failed ref tracks nothing rather than tracking zero');
      host.dispose();
    });
  } finally {
    db.cleanup();
    sessions.cleanup();
    home.cleanup();
  }
}


// --------------------- a reporter stamps every round, changed or not
if (!hasZstd) {
  console.log('host: reporter fixture skipped (zstd unavailable)');
} else {
  const KEY = fakeKey(2);
  const log = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1000 } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 400, outputTokens: 25 } } },
  ]);
  const home = fixtureDir('dsh-tokens-home-');
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  /** Every request the reporter made, captured instead of sent. */
  const sent = [];
  let tick;
  try {
    await withEnv({ DEEPSEEK_API_KEY: KEY, DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: 'test-token' }, async () => {
      globalThis.fetch = async (url, options) => {
        sent.push({ url, headers: options.headers, body: JSON.parse(options.body) });
        return { ok: true, status: 200 };
      };
      // Capture the rescan cadence so a second round can be driven without
      // waiting a real minute. The returned handle is real, so the plugin's
      // own cleanup still works.
      globalThis.setInterval = (fn, ms) => {
        if (ms === 60_000) tick = fn;
        return realSetInterval(() => {}, ms);
      };
      const host = makeHost({ attached: [{ id: 'live-1', header: { createdAt: Date.now() }, usage: buckets(1, 0, 0, 0) }], stored: [] });
      Object.assign(host.config, {
        trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'] }],
        sessionsDir: log.dir,
        role: 'reporter',
        aggregatorUrl: 'http://127.0.0.1:1',
        collectorToken: 'test-token',
        instanceLabel: 'test-machine',
      });
      apply(host.ctx, host.config);
      // Poll on the published state, not on the fetch call: the request is
      // captured mid-flight, and the status only reaches the payload once the
      // round that made it has finished.
      const first = await waitFor(
        host.routes,
        (s) => sent.length >= 1 && s.tracked.reporter.state === 'ok',
        'the first report and its published status',
      );

      assert.equal(sent[0].url, 'http://127.0.0.1:1/ingest', 'a bare origin is completed to the ingest endpoint');
      assert.equal(sent[0].headers.authorization, 'Bearer test-token');
      assert.equal(sent[0].body.schema, 'dsh-month-tokens/snapshot/v1');
      assert.equal(sent[0].body.label, 'test-machine');
      assert.equal(typeof sent[0].body.instance, 'string');
      assert.match(sent[0].body.fingerprint, /^[0-9a-f]{64}$/u);
      assert.deepEqual(sent[0].body.totals, buckets(400, 25, 0, 0));
      // The key itself must never cross the wire, only its hash.
      assert.equal(JSON.stringify(sent[0].body).includes(KEY), false, 'the raw key must not be reported');
      assert.equal(first.tracked.reporter.state, 'ok');
      assert.ok(typeof first.tracked.reporter.lastAt === 'number');

      assert.ok(tick !== undefined, 'the rescan cadence must be registered');
      tick();
      await waitFor(host.routes, () => sent.length >= 2, 'the second report');

      // The next round reports even though nothing moved: `reportedAt` is the
      // only liveness signal a peer has, so a quiet instance must keep saying
      // it is alive. The numbers are identical, which is the point.
      assert.deepEqual(sent[1].body.totals, sent[0].body.totals, 'the second round carried unchanged numbers');
      assert.ok(sent[1].body.seq > sent[0].body.seq, 'seq rises across rounds');
      assert.ok(sent[1].body.reportedAt >= sent[0].body.reportedAt, 'the stamp never goes backwards');
      assert.ok(
        Math.abs(Date.now() - sent[1].body.reportedAt) < 60_000,
        'reportedAt is wall-clock milliseconds, not a counter or zero',
      );
      assert.notEqual(sent[1].body.reportedAt, 0);
      host.dispose();
    });
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    log.cleanup();
    home.cleanup();
  }
}


// ------------- an aggregator repaints the moment a peer reports, not a cycle later
if (!hasZstd) {
  console.log('host: aggregator loopback check skipped (zstd unavailable)');
} else {
  const KEY = fakeKey(3);
  const expectedShort = fingerprintOfKey(KEY).fingerprint.slice(0, 8);
  const log = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'm', contextWindow: 1 } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 1100 } } },
  ]);
  const home = fixtureDir('dsh-tokens-home-');
  const realFetch = globalThis.fetch;
  try {
    await withEnv({ DEEPSEEK_API_KEY: KEY, DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: 'shared-secret' }, async () => {
      // The reporter's own outbound call is stubbed; the loopback calls below
      // use the captured real fetch, so the listener is exercised for real.
      globalThis.fetch = async () => ({ ok: true, status: 200 });
      const host = makeHost({ attached: [], stored: [] });
      Object.assign(host.config, {
        role: 'both',
        collectorToken: 'shared-secret',
        // Port 0 asks the OS for a free port: a fixed one would collide with
        // whatever else is running on this machine.
        collectorPort: 0,
        aggregatorUrl: 'http://127.0.0.1:1/unused',
        trackKeys: [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'] }],
        sessionsDir: log.dir,
        instanceLabel: 'machine-a',
      });
      apply(host.ctx, host.config);
      const settledCollector = await waitFor(
        host.routes,
        (s) => (['listening', 'error', 'noToken'].includes(s.tracked.collector.state) ? s : undefined),
        'the collector to settle',
      );
      const state = settledCollector.tracked.collector.state;
      if (state !== 'listening') {
        // A sandbox that forbids binding a socket must not fail the suite; it
        // must say so, because a silent pass here would hide a dead aggregator.
        console.log(`host: aggregator loopback check skipped (collector state: ${state})`);
        host.dispose();
        return;
      }
      const port = settledCollector.tracked.collector.port;
      const ingest = `http://127.0.0.1:${String(port)}/ingest`;

      // The token gate is the only thing between a peer's counts and anyone
      // who can reach the port.
      assert.equal((await realFetch(ingest, { method: 'POST', body: '{}' })).status, 401, 'no bearer is refused');
      assert.equal(
        (await realFetch(ingest, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status,
        401,
        'a wrong bearer is refused',
      );

      const peer = 'b'.repeat(64);
      const response = await realFetch(ingest, {
        method: 'POST',
        headers: { authorization: 'Bearer shared-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: 'dsh-month-tokens/snapshot/v1',
          instance: 'peer-1',
          label: 'peer',
          fingerprint: peer,
          month: new Date().toISOString().slice(0, 7),
          totals: buckets(5000, 200, 0, 0),
          days: {},
          models: {},
          uncovered: ['peer-only-route'],
          seq: 1,
          reportedAt: Date.now(),
        }),
      });
      assert.equal(response.status, 200);

      // No scan cadence is driven here: the peer's report alone must reach the
      // payload, which is what makes an open panel update when a teammate's
      // machine checks in.
      const merged = await waitFor(host.routes, (s) => (s.tracked.keys.some((key) => key.fingerprint === peer) ? s : undefined), 'the peer key to be published');
      assert.equal(merged.tracked.collector.instances, 2, 'the aggregate counts both machines');
      assert.ok(merged.tracked.uncovered.includes('peer-only-route'), "a peer's uncovered route is surfaced too");
      const local = merged.tracked.keys.find((key) => key.fingerprint !== peer);
      assert.equal(local.short, expectedShort, 'the local snapshot is normalized on its way into its own store');
      assert.equal(local.month, 1100, 'and it carries this machine\'s own figures');
      // The flag is what lets a client tell "my keys" from "keys I merely heard
      // about": without it the headline would sum the peer's key under a label
      // that says "my key", which is a different question than the one asked.
      assert.equal(local.trackedHere, true, 'a key configured here is mine');
      assert.equal(
        merged.tracked.keys.find((key) => key.fingerprint === peer).trackedHere,
        false,
        "a key only a peer reported is not",
      );
      // A machine whose last report was in an earlier month must not donate
      // that month's figure to this one. The aggregate is read *for* a month,
      // and the peer could be switched off for weeks — precisely the window in
      // which nobody would notice last month's number wearing this month's
      // label.
      const oldPeer = 'c'.repeat(64);
      await realFetch(ingest, {
        method: 'POST',
        headers: { authorization: 'Bearer shared-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
          schema: 'dsh-month-tokens/snapshot/v1',
          instance: 'peer-old',
          label: 'peer-old',
          fingerprint: oldPeer,
          month: '2020-01',
          totals: buckets(7000, 0, 0, 0),
          days: { '2020-01-15': buckets(7000, 0, 0, 0) },
          models: { 'ancient-model': buckets(7000, 0, 0, 0) },
          uncovered: [],
          seq: 1,
          reportedAt: Date.now(),
        }),
      });
      const withOld = await waitFor(
        host.routes,
        (summary) => (summary.tracked.keys.some((key) => key.fingerprint === oldPeer) ? summary : undefined),
        'the earlier-month peer',
      );
      const oldKey = withOld.tracked.keys.find((key) => key.fingerprint === oldPeer);
      assert.equal(oldKey.month, 0, "an earlier month's days are not this month's");
      assert.deepEqual(oldKey.days, {}, 'and they are not published as this month either');
      assert.deepEqual(oldKey.models, {}, 'nor its models, which carry no date of their own');
      assert.equal(oldKey.instances[0].total, 0, 'and its row contributes nothing to the month');
      assert.equal(oldKey.totals.uncachedInputTokens, 7000, 'while its all-time figure is kept, as designed');
      host.dispose();
    });
  } finally {
    globalThis.fetch = realFetch;
    log.cleanup();
    home.cleanup();
  }
}


// ------------------- opencode read for attribution: by provider, by local day
{
  const window = monthWindow(Date.now());
  assert.deepEqual(
    await readOpencodeAttribution({ dbPath: 'unused', provider: 'deepseek', monthStart: window.start, sqliteLoader: async () => undefined }),
    { state: 'unavailable', message: 'node:sqlite is not available in this runtime' },
    'a runtime without node:sqlite must say so, not report a zero',
  );
  assert.equal(
    (await readOpencodeAttribution({ dbPath: join(tmpdir(), 'no-such-opencode-db'), provider: 'deepseek', monthStart: window.start })).state,
    'absent',
  );

  if (hasSqlite) {
    const now = Date.now();
    const db = fixtureDb([
      { time: now, data: { role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-v4-pro', tokens: { input: 100, output: 10, reasoning: 5, cache: { read: 900, write: 0 } } } },
      { time: now, data: { role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-v4-flash', tokens: { input: 50, output: 1, cache: { read: 0, write: 0 } } } },
      { time: now - 40 * 86400000, data: { role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-v4-pro', tokens: { input: 7, output: 1, cache: { read: 0, write: 0 } } } },
      { time: now, data: { role: 'assistant', providerID: 'google', modelID: 'gemini', tokens: { input: 999, output: 0, cache: { read: 0, write: 0 } } } },
    ]);
    try {
      const attributed = await readOpencodeAttribution({ dbPath: db.path, provider: 'deepseek', monthStart: window.start });
      assert.equal(attributed.state, 'ok');
      assert.deepEqual(
        attributed.days[todayKey()],
        buckets(150, 16, 900, 0),
        'grouped into the same local day key the log fold uses, with reasoning folded into output',
      );
      assert.equal(attributed.models['deepseek-v4-pro'].uncachedInputTokens, 100, 'the model split is month-scoped, like the log fold');
      assert.equal(attributed.models.google, undefined, 'another provider is never read, even in the same table');
      assert.equal(attributed.totals.uncachedInputTokens, 157, 'while the all-time figure does include the earlier month');
      assert.equal(attributed.totals.outputTokens, 17);
      assert.equal(attributed.messages, 2, 'neither the other provider nor the earlier month is counted');
    } finally {
      db.cleanup();
    }
  }
}

// ------------------- opencode is folded in only when its key IS this key
if (!hasSqlite || !hasZstd) {
  console.log('host: opencode-attribution fixtures skipped (sqlite or zstd unavailable)');
} else {
  const OC_KEY = fakeKey(2);
  const OTHER_KEY = fakeKey(3);

  /**
   * Run the plugin once against a log and an opencode store, and report the key.
   * @param storeKey - the key opencode has stored.
   * @returns the published summary.
   */
  async function attributedSummary(storeKey) {
    const log = fixtureSessionLog([
      { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
      { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000 } } },
    ]);
    const opencodeDb = fixtureDb([
      { time: Date.now(), data: { role: 'assistant', providerID: 'deepseek', modelID: 'deepseek-v4-pro', tokens: { input: 500, output: 50, cache: { read: 0, write: 0 } } } },
    ]);
    const auth = fixtureDir('dsh-tokens-auth-');
    writeFileSync(join(auth.dir, 'auth.json'), JSON.stringify({ deepseek: { type: 'api', key: storeKey } }));
    const host = makeHost();
    host.config.sessionsDir = log.dir;
    host.config.opencodeDbPath = opencodeDb.path;
    host.config.opencodeAuthPath = join(auth.dir, 'auth.json');
    host.config.trackKeys = [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'], providerPatterns: ['deepseek'] }];
    try {
      apply(host.ctx, host.config);
      return await waitFor(
        host.routes,
        // A positive month is the honest condition for "the log share landed":
        // the opencode verdict is written before the log scan runs, and it
        // alone can make `days` non-empty, so waiting on that would read a key
        // whose DSH half is still missing and call the difference a bug.
        (summary) => summary.tracked?.keys?.[0]?.month > 0 && summary.tracked.opencode?.state !== 'absent',
        'the tracked key and its opencode verdict',
      );
    } finally {
      host.dispose();
      log.cleanup();
      opencodeDb.cleanup();
      auth.cleanup();
    }
  }

  const home = fixtureDir('dsh-tokens-home-');
  await withEnv({ DEEPSEEK_API_KEY: OC_KEY, DSH_HOME: home.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
    try {
      const summary = await attributedSummary(OC_KEY);
      const key = summary.tracked.keys[0];
      assert.equal(key.short, fingerprintOfKey(OC_KEY).fingerprint.slice(0, 8));
      assert.equal(
        key.month,
        1000 + 100 + 9000 + 500 + 50,
        'the log share and the opencode share are one month under one key',
      );
      assert.equal(summary.tracked.opencode.state, 'ok');
      assert.equal(summary.tracked.opencode.provider, 'deepseek');
      // The DSH models and opencode's model share one split, because they are
      // one key's spend: separating them would make the month unfalsifiable.
      assert.equal(key.models['deepseek-v4-pro'].uncachedInputTokens, 1500);

      // And the negative case, which is the whole reason attribution runs on
      // the fingerprint instead of the provider name: opencode's `deepseek`
      // entry holding a DIFFERENT key is somebody else's spend on the company
      // account, and folding it in would inflate mine.
      const other = await attributedSummary(OTHER_KEY);
      assert.equal(other.tracked.opencode.state, 'otherKey', 'a different key on the same provider is reported, not guessed at');
      assert.equal(other.tracked.opencode.provider, null);
      assert.deepEqual(other.tracked.opencode.providers, ['deepseek'], 'the provider list is surfaced so the reason is legible');
      assert.equal(
        other.tracked.keys[0].month,
        1000 + 100 + 9000,
        'another key\'s opencode usage must never reach this key\'s total',
      );
      assert.equal(other.tracked.keys[0].models['deepseek-v4-pro'].uncachedInputTokens, 1000);
    } finally {
      home.cleanup();
    }
  });
}


// ------------------- two machines, one key: the whole reporting path
// The pieces are covered separately elsewhere (the aggregator accepts a peer
// report; the reporter serializes a snapshot), but nothing exercised a real
// reporter POSTing to a real listener and the aggregate that results. That is
// the path a second machine actually uses, so it is run here end to end: two
// plugin instances, two identities, real HTTP over loopback.
if (!hasZstd) {
  console.log('host: two-machine fixture skipped (zstd unavailable)');
} else {
  const KEY = fakeKey(4);
  const shared = [{ ref: 'DEEPSEEK_API_KEY', providers: ['deepseek-official'] }];
  const logA = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 1000, outputTokens: 100 } } },
  ]);
  const logB = fixtureSessionLog([
    { type: 'request/context', time: Date.now(), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } },
    { type: 'assistant/message', time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 50 } } },
  ]);
  const homeA = fixtureDir('dsh-tokens-home-a-');
  const homeB = fixtureDir('dsh-tokens-home-b-');
  // Distinct identities, because two machines that believed they were one
  // would overwrite each other's row instead of adding to it.
  writeFileSync(join(homeA.dir, '.anonymous-user-id'), '11111111-1111-4111-8111-111111111111');
  writeFileSync(join(homeB.dir, '.anonymous-user-id'), '22222222-2222-4222-8222-222222222222');

  await withEnv({ DEEPSEEK_API_KEY: KEY, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
    const hostA = makeHost();
    process.env.DSH_HOME = homeA.dir;
    Object.assign(hostA.config, {
      role: 'both',
      collectorToken: 'shared-secret',
      collectorPort: 0,
      instanceLabel: 'machine-a',
      sessionsDir: logA.dir,
      trackKeys: shared,
    });
    apply(hostA.ctx, hostA.config);
    try {
      const settled = await waitFor(
        hostA.routes,
        (summary) => (['listening', 'error', 'noToken'].includes(summary.tracked.collector.state) ? summary : undefined),
        'the aggregator to settle',
      );
      if (settled.tracked.collector.state !== 'listening') {
        console.log(`host: two-machine check skipped (collector state: ${settled.tracked.collector.state})`);
        return;
      }
      const port = settled.tracked.collector.port;

      // The second machine, with its own home, identity, and log.
      process.env.DSH_HOME = homeB.dir;
      const hostB = makeHost();
      Object.assign(hostB.config, {
        role: 'reporter',
        aggregatorUrl: `http://127.0.0.1:${String(port)}/ingest`,
        collectorToken: 'shared-secret',
        instanceLabel: 'machine-b',
        sessionsDir: logB.dir,
        trackKeys: shared,
      });
      apply(hostB.ctx, hostB.config);
      try {
        // No fetch is stubbed here on purpose: the point is the real request.
        const reported = await waitFor(
          hostB.routes,
          (summary) => (summary.tracked.reporter.state === 'ok' ? summary : undefined),
          'machine B to report',
        );
        assert.equal(reported.tracked.keys[0].month, 550, 'B measures its own log');
        assert.equal(reported.tracked.keys[0].instances[0].label, 'machine-b');

        const merged = await waitFor(
          hostA.routes,
          (summary) => (summary.tracked.collector.instances === 2 ? summary : undefined),
          'the peer to appear in the aggregate',
        );
        const key = merged.tracked.keys[0];
        const labels = key.instances.map((instance) => instance.label).sort();
        assert.deepEqual(labels, ['machine-a', 'machine-b'], 'one key, two machines');
        const byLabel = new Map(key.instances.map((instance) => [instance.label, instance.total]));
        const total = key.instances.reduce((sum, instance) => sum + instance.total, 0);
        assert.equal(total, key.month, 'the rows reconcile with the month they add up to');
        assert.equal(
          byLabel.get('machine-a'),
          key.month - byLabel.get('machine-b'),
          'each machine contributes its own figure and nothing else',
        );
        assert.equal(key.trackedHere, true, 'the key is configured here, so it is mine');
      } finally {
        hostB.dispose();
      }
    } finally {
      hostA.dispose();
      logA.cleanup();
      logB.cleanup();
      homeA.cleanup();
      homeB.cleanup();
    }
  });
}


// ================= Pen and WorkBuddy: the two JSONL readers (§4.2.2) ========

// ------------------------------------------- Pen: month, provider, and shape
{
  const now = Date.now();
  const inMonth = now;
  const lastMonth = (() => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(1);
    date.setMonth(date.getMonth() - 1);
    return date.getTime();
  })();
  const pen = fixtureJsonl('dsh-tokens-pen-', {
    'a.jsonl': [
      penLine(inMonth, { input: 100, output: 40, cacheRead: 900, cacheWrite: 1, reasoning: 20, totalTokens: 1041 }),
      penLine(lastMonth, { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: 3, totalTokens: 10 }),
      penLine(inMonth, { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 5, totalTokens: 10 }, 'openai', 'gpt-x'),
      { type: 'model_change', timestamp: inMonth },
      { type: 'message', message: { role: 'user', timestamp: inMonth } },
    ],
  });
  try {
    const window = monthWindow(now);

    const month = await readPenMonth({ sessionsDir: pen.dir, providers: ['deepseek'], monthStart: window.start });
    assert.equal(month.state, 'ok');
    assert.equal(month.messages, 1, 'last month and the other provider are both out of scope');
    assert.deepEqual(month.totals, buckets(100, 40, 900, 1), 'reasoning is already inside output and must not be added');

    const attribution = await readPenAttribution({ sessionsDir: pen.dir, provider: 'deepseek', monthStart: window.start });
    assert.equal(attribution.state, 'ok');
    assert.deepEqual(attribution.totals, buckets(107, 43, 900, 1), 'totals are all-time');
    assert.equal(Object.keys(attribution.days).length, 1, 'days are this month only');
    assert.deepEqual({ ...attribution.models }, { 'deepseek-v4-flash-vision-exp': buckets(100, 40, 900, 1) }, 'and so are the models');

    // A provider the config does not watch contributes nothing to the row.
    const other = await readPenMonth({ sessionsDir: pen.dir, providers: ['openai'], monthStart: window.start });
    assert.equal(other.messages, 1, 'the provider filter is real, not decorative');
    assert.deepEqual(other.totals, buckets(5, 5, 0, 0));

    assert.equal((await readPenMonth({ sessionsDir: join(pen.dir, 'nope'), providers: ['deepseek'], monthStart: window.start })).state, 'absent');
    assert.equal((await readPenAttribution({ sessionsDir: join(pen.dir, 'nope'), provider: 'deepseek', monthStart: window.start })).state, 'absent');
  } finally {
    pen.cleanup();
  }
}

// ------------------------------- Pen: drift is reported, never read as zero
{
  const now = Date.now();
  const window = monthWindow(now);
  const drifted = fixtureJsonl('dsh-tokens-pen-drift-', {
    'a.jsonl': [
      // An assistant message whose usage fields all moved somewhere else.
      { type: 'message', message: { role: 'assistant', provider: 'deepseek', model: 'm', timestamp: now, usage: { promptTokens: 1 } } },
    ],
  });
  const empty = fixtureJsonl('dsh-tokens-pen-empty-', {
    'a.jsonl': [
      // A settlement that genuinely spent nothing is not drift.
      penLine(now, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 0 }),
    ],
  });
  const garbage = fixtureJsonl('dsh-tokens-pen-garbage-', { 'a.jsonl': [] });
  writeFileSync(join(garbage.dir, 'a.jsonl'), '{ not json at all\n');
  const unopenable = fixtureJsonl('dsh-tokens-pen-unopenable-', { 'a.jsonl': [penLine(now, { input: 1, output: 1 })] });
  chmodSync(join(unopenable.dir, 'a.jsonl'), 0o000);
  try {
    const drift = await readPenAttribution({ sessionsDir: drifted.dir, provider: 'deepseek', monthStart: window.start });
    assert.equal(drift.state, 'drift', 'a message with no readable usage must not pass as an empty month');
    assert.equal(drift.messages, 1);

    const zero = await readPenAttribution({ sessionsDir: empty.dir, provider: 'deepseek', monthStart: window.start });
    assert.equal(zero.state, 'ok', 'a real zero is not drift');
    assert.equal(sumOf(zero.totals), 0);

    const garbageView = await readPenMonth({ sessionsDir: garbage.dir, providers: ['deepseek'], monthStart: window.start });
    assert.equal(garbageView.state, 'drift', 'a file whose every line fails to parse is a structural change, not an empty month');

    const unopenableView = await readPenMonth({ sessionsDir: unopenable.dir, providers: ['deepseek'], monthStart: window.start });
    assert.equal(unopenableView.state, 'error', 'a file that cannot be opened at all is an error');
  } finally {
    drifted.cleanup();
    empty.cleanup();
    garbage.cleanup();
    chmodSync(join(unopenable.dir, 'a.jsonl'), 0o600);
    unopenable.cleanup();
  }
}

// ------------------------- WorkBuddy: the join, the month, and the envelope
{
  const now = Date.now();
  const inMonth = now;
  const lastMonth = (() => {
    const date = new Date(now);
    date.setHours(12, 0, 0, 0);
    date.setDate(1);
    date.setMonth(date.getMonth() - 1);
    return date.getTime();
  })();
  const usage = { prompt_cache_miss_tokens: 100, prompt_cache_hit_tokens: 900, prompt_cache_write_tokens: 1, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 1011 };
  const wb = fixtureJsonl('dsh-tokens-wb-', {
    'project/session.jsonl': [
      wbLine(inMonth, usage),
      // The same conversation's other events: `providerData` without usage.
      wbEventLine(inMonth),
      wbEventLine(inMonth),
    ],
    'project/subagents/agent-1.jsonl': [
      // A subagent transcript lives one level deeper and counts too.
      wbLine(inMonth, { prompt_cache_miss_tokens: 1, prompt_cache_hit_tokens: 0, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 1 }, total_tokens: 3 }, 'custom-local:deepseek-v4-pro', 'deepseek-pro'),
      wbLine(lastMonth, { prompt_cache_miss_tokens: 999, completion_tokens: 0, total_tokens: 999 }),
      // WorkBuddy's own gateway: not a configured provider, so never joined.
      wbLine(inMonth, { prompt_cache_miss_tokens: 888_888, completion_tokens: 0, total_tokens: 888_888, credit: 1 }, 'auto', 'glm-5.2'),
    ],
  });
  try {
    const window = monthWindow(now);

    const month = await readWorkbuddyMonth({ projectsDir: wb.dir, monthStart: window.start });
    assert.equal(month.state, 'ok');
    // Two settlements reach the machine row — the root session and the subagent
    // transcript — while the two sibling events and the gateway row do not.
    assert.equal(month.messages, 2, 'only a settlement is a request: the sibling events are not another one');
    assert.deepEqual(month.totals, buckets(101, 12, 900, 1), 'reasoning is a subset of completion_tokens and must not be added');

    const attribution = await readWorkbuddyAttribution({ projectsDir: wb.dir, modelIds: ['deepseek-v4-flash'], monthStart: window.start });
    assert.equal(attribution.state, 'ok');
    assert.deepEqual(attribution.totals, buckets(1099, 10, 900, 1), 'totals are all-time, so last month is still in them');
    assert.deepEqual({ ...attribution.models }, { 'deepseek-flash': buckets(100, 10, 900, 1) }, 'but the model split is this month');
    assert.deepEqual({ ...attribution.days }, { [todayKey()]: buckets(100, 10, 900, 1) }, 'and so is the day split');
    assert.equal(sumOf(attribution.totals) - sumOf(attribution.models['deepseek-flash']), 999, 'the difference is exactly last month');

    // The second configured id is only reachable with its id in the list.
    const both = await readWorkbuddyAttribution({ projectsDir: wb.dir, modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'], monthStart: window.start });
    assert.deepEqual(both.totals, buckets(1100, 12, 900, 1), 'every matched id contributes, across nested directories');
    assert.deepEqual(Object.keys(both.models).sort(), ['deepseek-flash', 'deepseek-pro']);

    // The gateway row is in none of them, and the machine row does not
    // silently widen to include it.
    assert.equal(sumOf(month.totals) < 888_888, true, 'the gateway envelope must not reach the WorkBuddy row');

    assert.equal((await readWorkbuddyMonth({ projectsDir: join(wb.dir, 'nope'), monthStart: window.start })).state, 'absent');
    assert.equal((await readWorkbuddyAttribution({ projectsDir: join(wb.dir, 'nope'), modelIds: ['x'], monthStart: window.start })).state, 'absent');
  } finally {
    wb.cleanup();
  }
}

// --------------------------- WorkBuddy: its own drift and error states
{
  const now = Date.now();
  const window = monthWindow(now);
  const drifted = fixtureJsonl('dsh-tokens-wb-drift-', {
    'p/s.jsonl': [{ type: 'function_call', timestamp: now, providerData: { requestModelId: 'custom-local:deepseek-v4-flash', model: 'deepseek-flash', rawUsage: { moved: 1 } } }],
  });
  const garbage = fixtureJsonl('dsh-tokens-wb-garbage-', { 'p/s.jsonl': [] });
  writeFileSync(join(garbage.dir, 'p/s.jsonl'), 'not json\n');
  try {
    const drift = await readWorkbuddyMonth({ projectsDir: drifted.dir, monthStart: window.start });
    assert.equal(drift.state, 'drift', 'an envelope with no readable field is drift, not a zero');
    assert.equal(drift.messages, 1);
    assert.equal((await readWorkbuddyMonth({ projectsDir: garbage.dir, monthStart: window.start })).state, 'drift');
  } finally {
    drifted.cleanup();
    garbage.cleanup();
  }
}

// ---- the reasoning convention, pinned side by side (§8 item 6, F19) --------
//
// The single easiest mistake to inherit from the opencode reader is to add
// reasoning everywhere. The three products disagree, so the three readers are
// asserted against the *same* numbers and must disagree in exactly one place.
{
  const now = Date.now();
  const window = monthWindow(now);
  // 100 uncached + 900 cache read + 1 cache write + 10 output, with 5 reasoning
  // tokens that all three products report and only one of them excludes.
  const pen = fixtureJsonl('dsh-tokens-pen-reason-', {
    'a.jsonl': [penLine(now, { input: 100, output: 10, cacheRead: 900, cacheWrite: 1, reasoning: 5, totalTokens: 1011 })],
  });
  const wb = fixtureJsonl('dsh-tokens-wb-reason-', {
    'p/s.jsonl': [wbLine(now, { prompt_cache_miss_tokens: 100, prompt_cache_hit_tokens: 900, prompt_cache_write_tokens: 1, completion_tokens: 10, completion_tokens_details: { reasoning_tokens: 5 }, total_tokens: 1011 })],
  });
  try {
    const penView = await readPenAttribution({ sessionsDir: pen.dir, provider: 'deepseek', monthStart: window.start });
    const wbView = await readWorkbuddyAttribution({ projectsDir: wb.dir, modelIds: ['deepseek-v4-flash'], monthStart: window.start });
    assert.deepEqual(penView.totals, buckets(100, 10, 900, 1), 'Pen: reasoning is already inside output — 10, never 15');
    assert.deepEqual(wbView.totals, buckets(100, 10, 900, 1), 'WorkBuddy: reasoning is a subset of completion — 10, never 15');

    if (hasSqlite) {
      // opencode is the one that reports reasoning separately, so the same
      // numbers must come out five tokens larger — the contrast is the point.
      const db = fixtureDb([{ time: now, data: ocMessage('deepseek', { input: 100, output: 10, reasoning: 5, cache: { read: 900, write: 1 }, total: 1016 }) }]);
      try {
        const ocView = await readOpencodeAttribution({ dbPath: db.path, provider: 'deepseek', monthStart: window.start });
        assert.deepEqual(ocView.totals, buckets(100, 15, 900, 1), 'opencode: reasoning is separate and IS added — 15, not 10');
        assert.equal(sumOf(ocView.totals) - sumOf(penView.totals), 5, 'the three readers differ by exactly the reasoning tokens, and only opencode counts them');
        assert.equal(sumOf(ocView.totals) - sumOf(wbView.totals), 5);
      } finally {
        db.cleanup();
      }
    }
  } finally {
    pen.cleanup();
    wb.cleanup();
  }
}

// ================= Pen and WorkBuddy: attribution through the host ==========

/**
 * Write the two credential stores into one temp home-shaped directory.
 * @param dir - the directory to populate.
 * @param key - the key to store, or `undefined` to store nothing.
 */
function writeToolCredentials(dir, key) {
  mkdirSync(join(dir, 'pen'), { recursive: true });
  mkdirSync(join(dir, 'wb'), { recursive: true });
  if (key !== undefined) {
    // Pen's store is the same `{ provider: { type, key } }` shape opencode uses.
    writeFileSync(join(dir, 'pen', 'agent-auth'), JSON.stringify({ deepseek: { type: 'api_key', key } }));
    // WorkBuddy's is a list of its own configured providers.
    writeFileSync(join(dir, 'wb', 'models.json'), JSON.stringify([{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4 Flash', vendor: 'DeepSeek', apiKey: key }]));
  }
}

// ------------------------- the same key: both tools fold into the key's month
{
  const now = Date.now();
  const KEY = fakeKey(11);
  const short = fingerprintOfKey(KEY).fingerprint.slice(0, 8);
  const credentials = fixtureDir('dsh-tokens-creds-');
  const sessions = fixtureDir('dsh-tokens-empty-sessions-');
  writeToolCredentials(credentials.dir, KEY);
  const pen = fixtureJsonl('dsh-tokens-pen-live-', {
    'a.jsonl': [penLine(now, { input: 100, output: 10, cacheRead: 900, cacheWrite: 1, reasoning: 5, totalTokens: 1011 })],
  });
  // WorkBuddy's settlement lives one directory deeper, under `subagents/`.
  const wb = fixtureJsonl('dsh-tokens-wb-live-', {
    'p/subagents/a.jsonl': [wbLine(now, { prompt_cache_miss_tokens: 1000, prompt_cache_hit_tokens: 2000, completion_tokens: 100, completion_tokens_details: { reasoning_tokens: 40 }, total_tokens: 3100 })],
  });
  try {
    await withEnv({ DEEPSEEK_API_KEY: KEY, DSH_HOME: credentials.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [], stored: [] });
      host.config.trackKeys = ['DEEPSEEK_API_KEY'];
      host.config.sessionsDir = sessions.dir;
      host.config.collectorToken = '';
      host.config.penAuthPath = join(credentials.dir, 'pen', 'agent-auth');
      host.config.penSessionsDir = pen.dir;
      host.config.workbuddyModelsPath = join(credentials.dir, 'wb', 'models.json');
      host.config.workbuddyProjectsDir = wb.dir;
      apply(host.ctx, host.config);
      try {
        const summary = await waitFor(host.routes, (state) => state.tracked.keys[0]?.month === 4111, 'both tools folded in');
        const key = summary.tracked.keys[0];
        assert.equal(key.short, short);
        assert.equal(key.month, 4111, 'Pen 1011 + WorkBuddy 3100, both attributed to the key rather than to the product');
        assert.deepEqual(key.days[todayKey()], buckets(1100, 110, 2900, 1), 'both land in the same day bucket the log fold uses');
        assert.equal(summary.tracked.pen.state, 'ok', 'Pen matched');
        assert.equal(summary.tracked.workbuddy.state, 'ok', 'WorkBuddy matched');
        assert.deepEqual(summary.tracked.workbuddy.modelIds, ['deepseek-v4-flash'], 'the model ids travel with the match');
        assert.equal(summary.tracked.coverage, 'dsh+opencode+pen+workbuddy');
        // The machine rows carry the same numbers, because both are on my key.
        assert.equal(sumOf(summary.tools.pen.totals), 1011);
        assert.equal(sumOf(summary.tools.workbuddy.totals), 3100);
      } finally {
        host.dispose();
      }
    });
  } finally {
    credentials.cleanup();
    sessions.cleanup();
    pen.cleanup();
    wb.cleanup();
  }
}

// ------------- a colleague's key: excluded from the key, visible on the machine
{
  const now = Date.now();
  const MINE = fakeKey(12);
  const THEIRS = fakeKey(13);
  const credentials = fixtureDir('dsh-tokens-creds-');
  const sessions = fixtureDir('dsh-tokens-empty-sessions-');
  writeToolCredentials(credentials.dir, THEIRS);
  const pen = fixtureJsonl('dsh-tokens-pen-other-', {
    'a.jsonl': [penLine(now, { input: 100, output: 10, cacheRead: 900, cacheWrite: 1, totalTokens: 1011 })],
  });
  const wb = fixtureJsonl('dsh-tokens-wb-other-', {
    'p/a.jsonl': [wbLine(now, { prompt_cache_miss_tokens: 1000, prompt_cache_hit_tokens: 2000, completion_tokens: 100, total_tokens: 3100 })],
  });
  try {
    await withEnv({ DEEPSEEK_API_KEY: MINE, DSH_HOME: credentials.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [], stored: [] });
      host.config.trackKeys = ['DEEPSEEK_API_KEY'];
      host.config.sessionsDir = sessions.dir;
      host.config.collectorToken = '';
      host.config.penAuthPath = join(credentials.dir, 'pen', 'agent-auth');
      host.config.penSessionsDir = pen.dir;
      host.config.workbuddyModelsPath = join(credentials.dir, 'wb', 'models.json');
      host.config.workbuddyProjectsDir = wb.dir;
      apply(host.ctx, host.config);
      try {
        const summary = await waitFor(host.routes, (state) => state.tracked.pen.state === 'otherKey' && state.tracked.workbuddy.state === 'otherKey', 'both readers to report another key');
        assert.equal(summary.tracked.keys[0].month, 0, 'another key\u2019s spend is not mine, on any product');
        assert.equal(summary.tracked.pen.provider, null, 'nothing matched, so there is no provider to name');
        assert.deepEqual(summary.tracked.pen.providers, ['deepseek'], 'but the store it looked at is named');
        // The rows are where the design says they belong: visible, and outside
        // the key's number.
        assert.equal(sumOf(summary.tools.pen.totals), 1011, 'Pen usage stays visible on the machine row');
        assert.equal(sumOf(summary.tools.workbuddy.totals), 3100, 'and so does WorkBuddy');
      } finally {
        host.dispose();
      }
    });
  } finally {
    credentials.cleanup();
    sessions.cleanup();
    pen.cleanup();
    wb.cleanup();
  }
}

// --------------------- an unreadable credential is its own reported state
{
  const now = Date.now();
  const credentials = fixtureDir('dsh-tokens-creds-');
  const sessions = fixtureDir('dsh-tokens-empty-sessions-');
  mkdirSync(join(credentials.dir, 'pen'), { recursive: true });
  mkdirSync(join(credentials.dir, 'wb'), { recursive: true });
  writeFileSync(join(credentials.dir, 'pen', 'agent-auth'), '{ this is not json');
  writeFileSync(join(credentials.dir, 'wb', 'models.json'), 'neither is this');
  const pen = fixtureJsonl('dsh-tokens-pen-unread-', {
    'a.jsonl': [penLine(now, { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 })],
  });
  try {
    await withEnv({ DEEPSEEK_API_KEY: fakeKey(14), DSH_HOME: credentials.dir, DSH_TOKEN_LEDGER_TOKEN: undefined }, async () => {
      const host = makeHost({ attached: [], stored: [] });
      host.config.trackKeys = ['DEEPSEEK_API_KEY'];
      host.config.sessionsDir = sessions.dir;
      host.config.collectorToken = '';
      host.config.penAuthPath = join(credentials.dir, 'pen', 'agent-auth');
      host.config.penSessionsDir = pen.dir;
      host.config.workbuddyModelsPath = join(credentials.dir, 'wb', 'models.json');
      host.config.workbuddyProjectsDir = join(credentials.dir, 'wb');
      apply(host.ctx, host.config);
      try {
        const summary = await waitFor(host.routes, (state) => state.tracked.pen.state === 'unreadable' && state.tracked.workbuddy.state === 'unreadable', 'both stores to report unreadable');
        assert.equal(summary.tracked.keys[0].month, 0, 'an unattributable store contributes nothing rather than everything');
        // A parse failure has no `errno`-style code, so the reason arrives as the
        // error's own text — the same shape the opencode reader reports.
        assert.match(summary.tracked.pen.message, /SyntaxError/, 'the reason is carried, so the panel can say why');
        assert.equal(sumOf(summary.tools.pen.totals), 2, 'the machine row is unaffected: it never needed the credential');
      } finally {
        host.dispose();
      }
    });
  } finally {
    credentials.cleanup();
    sessions.cleanup();
    pen.cleanup();
  }
}

// --------- neither tool installed: both rows are absent, and the panel is quiet
{
  const host = makeHost({ attached: [], stored: [] });
  apply(host.ctx, host.config);
  try {
    const summary = await waitFor(host.routes, (state) => state.tools.pen.state !== 'loading' && state.tools.workbuddy.state !== 'loading', 'the two readers to settle');
    assert.equal(summary.tools.pen.state, 'absent');
    assert.equal(summary.tools.workbuddy.state, 'absent');
    assert.equal(summary.tracked.pen.state, 'absent', 'with nothing tracked, nothing is attributed either');
    assert.equal(summary.tracked.workbuddy.state, 'absent');
  } finally {
    host.dispose();
  }
}

console.log('host.test.mjs: all checks passed');
