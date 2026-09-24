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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import { apply, inject, activityMonthTokens, monthContribution, monthWindow, readOpencodeAttribution, readOpencodeMonth } from '../lib/index.js';
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
    assert.equal(summary.tracked.coverage, 'dsh+opencode');
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
  const KEY = 'sk-00000000000000000000000000000001';
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
      assert.equal(summary.tracked.coverage, 'dsh+opencode');
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
  const KEY = 'sk-00000000000000000000000000000002';
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
  const KEY = 'sk-00000000000000000000000000000003';
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
  const OC_KEY = 'sk-00000000000000000000000000000002';
  const OTHER_KEY = 'sk-00000000000000000000000000000003';

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
  const KEY = 'sk-00000000000000000000000000000004';
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


console.log('host.test.mjs: all checks passed');
