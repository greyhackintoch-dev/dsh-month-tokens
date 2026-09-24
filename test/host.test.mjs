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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, inject, activityMonthTokens, monthContribution, monthWindow, readOpencodeMonth } from '../lib/index.js';

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
    // Never the real database: every test states its own fixture or none.
    config: { opencodeDbPath: join(tmpdir(), 'dsh-month-tokens-no-such-opencode.db') },
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


console.log('host.test.mjs: all checks passed');
