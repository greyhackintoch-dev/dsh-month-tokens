/**
 * dsh-month-tokens — host half.
 *
 * One number: how many provider-reported tokens this machine has burned
 * **this calendar month**. The period is derived from the clock on every read,
 * so the counter restarts at 00:00 on the 1st without a stored counter and
 * without a reset job that could be missed.
 *
 * Two local sources feed it, and neither talks to the network:
 *
 *   - **This DSH home.** Per session, the freshest source wins for the
 *     all-time figure: an **attached** session is read through the live
 *     `tokenUsage` projection and kept current by the registry's change feed; a
 *     **cold** one through the projection cache's zero-I/O listing read; a
 *     **seeded** (fork-inherited) cold one is skipped rather than guessed,
 *     because its checkpoint identity needs the exact inherited cut that no
 *     header-only listing carries.
 *   - **opencode**, read from its own SQLite database. Those calls never pass
 *     through DSH, so this is the only way to see them, and it is strictly
 *     per-completed-message: a poll, never a live tap.
 *
 * Turning a cumulative figure into a *month* figure is the hard part, and it is
 * why this plugin reports how it derived each part instead of just asserting a
 * number. See {@link monthContribution} for the DSH ladder.
 *
 * @module dsh-month-tokens
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Exact route serving the ledger as one JSON snapshot. */
const SUMMARY_ROUTE = '/token-ledger/summary';
/** Exact route serving the ledger as a server-sent-event stream. */
const STREAM_ROUTE = '/token-ledger/stream';
/** Keep-alive comment cadence, so idle intermediaries do not drop a quiet stream. */
const HEARTBEAT_MS = 25_000;
/** Cold-session rescan cadence; live sessions arrive through the change feed. */
const RESCAN_MS = 60_000;
/** opencode poll cadence — its rows land per completed message, not per token. */
const OPENCODE_POLL_MS = 60_000;
/** opencode's database, relative to the home directory. */
const OPENCODE_DB_SUBPATH = '.local/share/opencode/opencode.db';
/** The providers whose opencode usage belongs to this ledger by default. */
const OPENCODE_DEFAULT_PROVIDERS = ['deepseek'];
/** The disjoint prompt-side and completion buckets a provider reports. */
const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** Required services: the persistence listing, both projection reads, and the route seat. */
export const inject = ['webServer', 'sessionPersistence', 'sessionProjections', 'sessionProjectionCache'];

/**
 * A zeroed bucket set.
 * @returns four zero counts.
 */
function zeroBuckets() {
  return { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Narrow one projection value to a bucket set.
 * @param value - a `tokenUsage` projection value, of unknown shape at this edge.
 * @returns the bucket set, or `undefined` when the value is absent or malformed.
 */
function bucketsOf(value) {
  if (value === null || typeof value !== 'object') return undefined;
  const out = {};
  for (const key of BUCKETS) {
    const count = value[key];
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined;
    out[key] = count;
  }
  return out;
}

/**
 * Whether two bucket sets carry the same numbers.
 * @param a - previous value, or `undefined` when absent.
 * @param b - next value, or `undefined` when absent.
 * @returns true when no republish is warranted.
 */
function sameBuckets(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return BUCKETS.every((key) => a[key] === b[key]);
}

/**
 * Sum one bucket set into another.
 * @param into - accumulator, mutated.
 * @param from - the bucket set to add.
 */
function addInto(into, from) {
  for (const key of BUCKETS) into[key] += from[key];
}

/**
 * Sum a bucket set's four counts.
 * @param buckets - the bucket set.
 * @returns total tokens.
 */
function sumBuckets(buckets) {
  let total = 0;
  for (const key of BUCKETS) total += buckets[key];
  return total;
}

/**
 * The reporting period: the current local calendar month, from the 1st at
 * 00:00 through tomorrow's local midnight.
 *
 * Nothing is accumulated across a boundary — the window is derived from the
 * clock on every read, so a process that slept through midnight on the 1st
 * still reports the new month the moment it looks again. `end` is tomorrow
 * rather than the next month's 1st so the range never runs wholly into the
 * future.
 * @param now - current epoch milliseconds.
 * @returns window bounds and the `YYYY-MM` key.
 */
export function monthWindow(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(1);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  const year = String(start.getFullYear()).padStart(4, '0');
  const month = String(start.getMonth() + 1).padStart(2, '0');
  return { start: start.getTime(), end: end.getTime(), key: `${year}-${month}` };
}

/**
 * Sum one session's per-day activity ledger over a month.
 *
 * A day ledger is keyed by local calendar day (`YYYY-MM-DD`), which is exactly
 * the month boundary this period uses. It belongs to an optional sibling
 * projection, so the return value separates "this session has no ledger" from
 * "this session's ledger records nothing this month": a present ledger is
 * authoritative and may legitimately answer zero, while a missing or malformed
 * one must send the caller to its fallback rather than silently contributing
 * nothing.
 * @param value - the raw `contextActivity` projection value, of unknown shape.
 * @param monthKey - the `YYYY-MM` prefix to keep.
 * @returns billed tokens inside the month, or `undefined` when there is no ledger.
 */
export function activityMonthTokens(value, monthKey) {
  const days = value?.days;
  if (days === null || typeof days !== 'object' || Array.isArray(days)) return undefined;
  let total = 0;
  for (const [day, entry] of Object.entries(days)) {
    if (!day.startsWith(`${monthKey}-`)) continue;
    const tokens = entry?.tokens;
    if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) continue;
    total += tokens;
  }
  return total;
}

/**
 * Load `node:sqlite`, which is still flagged experimental, without making it a
 * load-time dependency of the whole plugin.
 * @returns the module, or `undefined` when this runtime lacks it.
 */
async function loadSqlite() {
  try {
    return await import('node:sqlite');
  } catch {
    return undefined;
  }
}

/**
 * Total tokens in one bucket set, tolerating an absent one.
 * @param buckets - a bucket set, or `undefined`.
 * @returns total tokens.
 */
function sumOf(buckets) {
  return sumBuckets(buckets ?? zeroBuckets());
}

/**
 * Coerce one SQL aggregate to a non-negative integer.
 * @param value - the raw aggregate, `null` when no row matched.
 * @returns the count.
 */
function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

/**
 * Read opencode's own record of this month's usage for the given providers.
 *
 * opencode stores one row per assistant message whose `data` JSON carries
 * `tokens: { input, output, reasoning, cache: { read, write }, total }`. Its
 * `input` is *uncached* — cache reads sit in their own field — so the four
 * buckets map one-to-one onto this ledger's vocabulary. The one translation is
 * `reasoning`: opencode reports it separately while DSH folds it into output,
 * so the two are added here to keep the rows comparable.
 *
 * The database is opened read-only and closed again on every poll: it is a
 * third-party schema under active write in WAL mode, so holding a handle buys
 * nothing and risks reading a stale snapshot. A schema drift that still queries
 * but yields no token fields is reported as `drift` rather than as a zero,
 * because a silently smaller month is the failure this plugin exists to avoid.
 * @param options - database path, providers to include, the month start, and an injectable sqlite loader.
 * @returns one of `ok`, `absent`, `drift`, `unavailable`, or `error`.
 */
export async function readOpencodeMonth(options) {
  const { dbPath, providers, monthStart, sqliteLoader = loadSqlite } = options;
  const sqlite = await sqliteLoader();
  if (sqlite === undefined) return { state: 'unavailable', message: 'node:sqlite is not available in this runtime' };
  if (!existsSync(dbPath)) return { state: 'absent', message: dbPath };

  let db;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    return { state: 'error', message: String(error) };
  }
  try {
    const placeholders = providers.map(() => '?').join(', ');
    const row = db
      .prepare(
        `SELECT COUNT(*) AS messages,
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS uncachedInput,
                COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS output,
                COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS cacheRead,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cacheWrite
           FROM message
          WHERE json_extract(data, '$.role') = 'assistant'
            AND json_extract(data, '$.providerID') IN (${placeholders})
            AND time_created >= ?`,
      )
      .get(...providers, monthStart);
    const totals = {
      uncachedInputTokens: count(row.uncachedInput),
      outputTokens: count(row.output) + count(row.reasoning),
      cacheReadTokens: count(row.cacheRead),
      cacheWriteTokens: count(row.cacheWrite),
    };
    const messages = count(row.messages);
    if (messages > 0 && sumBuckets(totals) === 0) {
      return { state: 'drift', message: `${String(messages)} messages carried no readable token fields`, messages };
    }
    return { state: 'ok', totals, messages, fetchedAt: Date.now() };
  } catch (error) {
    return { state: 'error', message: String(error) };
  } finally {
    try {
      db.close();
    } catch {
      // A close failure after a successful read changes nothing.
    }
  }
}

/**
 * Decide one session's contribution to the month.
 *
 * The ladder, in order:
 *
 *   1. `ledger` — an optional per-day ledger covers the month exactly.
 *   2. `born` — the session was created at or after the 1st, so everything it
 *      ever spent is this month's.
 *   3. `idle` — it was created earlier but its last user prompt predates the
 *      1st, so it spent nothing this month.
 *   4. `split` — created earlier *and* prompted this month. A cumulative
 *      per-session figure cannot be split across the boundary, and no shipped
 *      projection buckets usage by day. This contributes nothing and is counted
 *      in `unattributed`, because a silent zero here is exactly how a
 *      long-running session disappears from a fresh month.
 *
 * The `idle` rule reads `sessionListMetadata.lastPromptAt`, a first-party
 * projection, so only the genuinely ambiguous case is left over.
 * @param entry - the session's folded state.
 * @param period - the period from {@link monthWindow}.
 * @returns the contributing tokens and which rule decided it.
 */
export function monthContribution(entry, period) {
  const billed = sumBuckets(entry.buckets);
  const fromLedger = entry.days === undefined ? undefined : activityMonthTokens(entry.days, period.key);
  if (fromLedger !== undefined) return { tokens: fromLedger, how: 'ledger' };
  if (typeof entry.createdAt === 'number' && entry.createdAt >= period.start) return { tokens: billed, how: 'born' };
  // null is the projection reporting "no prompt yet"; undefined is the
  // projection never having been read, which is not the same fact.
  if (entry.lastPromptAt === null) return { tokens: 0, how: 'idle' };
  if (typeof entry.lastPromptAt === 'number' && entry.lastPromptAt < period.start) return { tokens: 0, how: 'idle' };
  return { tokens: 0, how: 'split' };
}

/**
 * Host plugin body: fold every session's usage into one published month total.
 * @param ctx - host context carrying the persistence, projection, and webserver services.
 */
export function apply(ctx, config) {
  const logger = ctx.logger('token-ledger');
  /** Where opencode lives and which of its providers belong to this ledger. */
  const opencodeSettings = {
    dbPath:
      typeof config?.opencodeDbPath === 'string' && config.opencodeDbPath !== ''
        ? config.opencodeDbPath
        : process.env.DSH_TOKEN_LEDGER_OPENCODE_DB || join(homedir(), OPENCODE_DB_SUBPATH),
    providers:
      Array.isArray(config?.opencodeProviders) && config.opencodeProviders.length > 0
        ? config.opencodeProviders.filter((entry) => typeof entry === 'string' && entry !== '')
        : OPENCODE_DEFAULT_PROVIDERS,
  };
  /** Freshest known state per session id. */
  const bySession = new Map();
  /** Session ids currently attached in this process. */
  const liveIds = new Set();
  /** Open SSE responses awaiting a publish. */
  const streams = new Set();
  let skippedSeeded = 0;
  let scannedAt = 0;
  let revision = 0;
  let published = null;
  let dirty = true;
  /** The period the published payload was built for; a change forces a rebuild. */
  let period = monthWindow(Date.now());
  /** This month's opencode usage, or why it is missing. */
  let opencode = { state: 'loading' };

  /** The sessions store, when this composition mounts one. */
  const sessionsStore = () => ctx.get('sessions');

  /**
   * Write one session's state, reporting whether anything moved.
   * @param id - session id.
   * @param next - `{ buckets, createdAt, lastPromptAt, days }`.
   * @returns true when the map changed.
   */
  function assign(id, next) {
    const previous = bySession.get(id);
    if (
      previous !== undefined &&
      sameBuckets(previous.buckets, next.buckets) &&
      previous.createdAt === next.createdAt &&
      previous.lastPromptAt === next.lastPromptAt &&
      previous.days === next.days
    ) {
      return false;
    }
    bySession.set(id, next);
    return true;
  }

  /**
   * Drop one session from the fold.
   *
   * Only the reconciling readers call this. The change feed never does: an
   * absent or malformed projection value means "no news", and must not erase a
   * session whose last good total is already counted.
   * @param id - session id.
   * @returns true when the map changed.
   */
  function forget(id) {
    return bySession.delete(id);
  }

  /**
   * Fold one projection cut into the session state this ledger needs.
   * @param values - one projection cut, possibly carrying only some keys.
   * @param buckets - the already-validated all-time bucket set.
   * @param createdAt - the session's creation time.
   * @param previous - the session's previous state, when this is an incremental update.
   * @returns the folded session state.
   */
  function stateOf(values, buckets, createdAt, previous) {
    const meta = values?.sessionListMetadata;
    // Three distinct facts: a number (the projection reported a prompt time),
    // null (the projection is present and reports no prompt yet), and undefined
    // (the projection was absent from every cut we read). Collapsing the last
    // two into null would let an unregistered unit masquerade as "nothing spent
    // this month" — the silent zero this ladder exists to avoid.
    const reported = meta === undefined ? undefined : typeof meta?.lastPromptAt === 'number' ? meta.lastPromptAt : null;
    const lastPromptAt = reported !== undefined ? reported : previous?.lastPromptAt;
    const days = values?.contextActivity ?? previous?.days;
    return { buckets, createdAt: createdAt ?? previous?.createdAt, lastPromptAt, days };
  }

  /**
   * Local all-time totals plus this month's figure and how it was derived.
   * @returns all-time buckets, the month total, its provenance, and the unattributable count.
   */
  function localTotals() {
    const all = zeroBuckets();
    let month = 0;
    const how = new Set();
    let unattributed = 0;
    for (const entry of bySession.values()) {
      addInto(all, entry.buckets);
      const contribution = monthContribution(entry, period);
      how.add(contribution.how);
      if (contribution.how === 'split') unattributed += 1;
      month += contribution.tokens;
    }
    const monthSource = bySession.size === 0 ? 'none' : how.size === 1 ? [...how][0] : 'mixed';
    return { all, month, monthSource, exact: unattributed === 0, unattributed };
  }

  /**
   * The current published payload, rebuilt only when something moved.
   * @returns the reference-stable payload for the current revision.
   */
  function payload() {
    // The clock, not a stored counter, decides the period — so a process that
    // was asleep at midnight on the 1st still reports the new month the moment
    // anything reads, and no reset job can be missed.
    const current = monthWindow(Date.now());
    if (current.key !== period.key) {
      period = current;
      dirty = true;
    }
    if (!dirty && published !== null) return published;
    const { all, month, monthSource, exact, unattributed } = localTotals();
    const opencodeMonth = opencode.state === 'ok' ? sumBuckets(opencode.totals) : 0;
    revision += 1;
    published = {
      revision,
      period: { kind: 'month', key: period.key, start: period.start, end: period.end },
      totals: all,
      month: month + opencodeMonth,
      local: { total: sumBuckets(all), month, monthSource, exact, unattributed },
      tools: { opencode },
      sessions: { counted: bySession.size, live: liveIds.size, skippedSeeded, scannedAt },
    };
    dirty = false;
    return published;
  }

  /** Mark the payload stale and fan the fresh one out to every open stream. */
  function publish() {
    dirty = true;
    if (streams.size === 0) return;
    const frame = `event: ledger\ndata: ${JSON.stringify(payload())}\n\n`;
    for (const res of streams) {
      try {
        res.write(frame);
      } catch (error) {
        logger.warn(`dropping stream after write failure: ${String(error)}`);
        streams.delete(res);
      }
    }
  }

  /** Adopt the attached sessions' own projections — authoritative and unpolled. */
  function refreshLive() {
    const store = sessionsStore();
    if (store === undefined) return false;
    let attached;
    try {
      attached = store.list();
    } catch (error) {
      logger.warn(`cannot list attached sessions: ${String(error)}`);
      return false;
    }
    let changed = false;
    const seen = new Set();
    for (const session of attached) {
      seen.add(session.id);
      // No key filter: the sibling units this ledger reads may or may not be
      // registered, and naming an unregistered key would be a stronger
      // coupling than reading whatever the cut carries.
      const snapshot = ctx.sessionProjections.snapshot(session);
      const next = bucketsOf(snapshot?.values?.tokenUsage);
      if (next === undefined) {
        if (forget(session.id)) changed = true;
        continue;
      }
      if (assign(session.id, stateOf(snapshot?.values, next, session.header?.createdAt, bySession.get(session.id)))) changed = true;
    }
    for (const id of liveIds) if (!seen.has(id)) liveIds.delete(id);
    for (const id of seen) liveIds.add(id);
    return changed;
  }

  /**
   * Reconcile every cold session against the durable projection cache.
   * @returns whether the fold may have moved.
   */
  async function scanCold() {
    let rows;
    try {
      rows = await ctx.sessionPersistence.list();
    } catch (error) {
      logger.warn(`cannot list stored sessions: ${String(error)}`);
      return false;
    }
    const attached = new Set();
    const store = sessionsStore();
    if (store !== undefined) {
      try {
        for (const session of store.list()) attached.add(session.id);
      } catch {
        // An unlistable store leaves the live set empty; cold rows still serve.
      }
    }
    const keep = new Set(attached);
    let seeded = 0;
    let changed = false;
    for (const row of rows) {
      const id = row.header.id;
      if (attached.has(id)) continue;
      if (row.header.isSeeded === true) {
        // The inherited cut is unknown to a header-only listing, so this
        // checkpoint cannot be identity-matched. Count it, never guess it.
        seeded += 1;
        continue;
      }
      keep.add(id);
      const snapshot = ctx.sessionProjectionCache.cachedSnapshot(row.header, 0);
      const next = bucketsOf(snapshot?.values?.tokenUsage);
      if (next === undefined) {
        // No durable checkpoint yet: this cold session contributes nothing
        // until a turn-end write lands, and must not keep a stale count.
        if (forget(id)) changed = true;
        continue;
      }
      if (assign(id, stateOf(snapshot?.values, next, row.header.createdAt, bySession.get(id)))) changed = true;
    }
    for (const id of [...bySession.keys()]) {
      if (keep.has(id)) continue;
      forget(id);
      changed = true;
    }
    skippedSeeded = seeded;
    scannedAt = Date.now();
    return changed;
  }

  /**
   * Re-read opencode's database, republishing only on a real movement.
   *
   * `fetchedAt` is deliberately excluded from the comparison: it moves on every
   * poll, and letting it count as a change would bump the revision — and
   * re-render every open panel — once a minute forever.
   */
  async function refreshOpencode() {
    let next;
    try {
      next = await readOpencodeMonth({ ...opencodeSettings, monthStart: monthWindow(Date.now()).start });
    } catch (error) {
      next = { state: 'error', message: String(error) };
    }
    const previous = opencode;
    const moved =
      previous.state !== next.state ||
      previous.messages !== next.messages ||
      !sameBuckets(previous.totals, next.totals);
    opencode = next;
    if (next.state === 'ok') logger.info(`opencode this month: ${String(sumOf(next.totals))} tokens over ${String(next.messages)} messages`);
    else if (next.state !== 'absent') logger.warn(`opencode usage unavailable (${next.state}): ${next.message ?? ''}`);
    if (moved) publish();
  }

  ctx.effect(() => {
    // The registry's change feed is the live half: one call per committed
    // session event whose client-visible value actually moved.
    const offChanged = ctx.sessionProjections.onChanged((session, key, value) => {
      if (key !== 'tokenUsage' && key !== 'sessionListMetadata') return;
      const previous = bySession.get(session.id);
      const next = key === 'tokenUsage' ? bucketsOf(value) : previous?.buckets;
      if (next === undefined) return;
      // The feed reports one key at a time, so a sibling keeps its last known
      // value instead of being read as withdrawn.
      const state = stateOf(
        { sessionListMetadata: key === 'sessionListMetadata' ? value : undefined },
        next,
        session.header?.createdAt,
        previous,
      );
      if (assign(session.id, state)) publish();
    });
    const heartbeat = setInterval(() => {
      for (const res of streams) {
        try {
          res.write(': keep-alive\n\n');
        } catch {
          streams.delete(res);
        }
      }
    }, HEARTBEAT_MS);
    const rescan = setInterval(() => {
      // Only a real movement republishes: an idle rescan must not bump the
      // revision and force every open panel to re-render.
      const liveMoved = refreshLive();
      void scanCold()
        .then((coldMoved) => {
          if (liveMoved || coldMoved) publish();
        })
        .catch((error) => {
          logger.warn(`ledger rescan failed: ${String(error)}`);
        });
    }, RESCAN_MS);
    // The counter is period-derived, so the reset needs no stored state — but
    // an open panel should turn over the moment the month does rather than
    // waiting for the next turn or rescan.
    let monthTimer;
    const scheduleMonth = () => {
      const now = Date.now();
      const next = new Date(now);
      next.setHours(0, 0, 0, 0);
      next.setDate(1);
      next.setMonth(next.getMonth() + 1);
      monthTimer = setTimeout(() => {
        logger.info(`token ledger period rolled over to ${monthWindow(Date.now()).key}`);
        publish();
        void refreshOpencode();
        scheduleMonth();
      }, Math.max(1_000, next.getTime() - now));
      monthTimer.unref?.();
    };
    scheduleMonth();
    // opencode writes one row per completed message, so there is nothing to
    // subscribe to — a poll is the only honest cadence it offers.
    let opencodeTimer;
    const scheduleOpencode = () => {
      opencodeTimer = setTimeout(() => {
        void refreshOpencode().finally(scheduleOpencode);
      }, OPENCODE_POLL_MS);
      opencodeTimer.unref?.();
    };
    void refreshOpencode().finally(scheduleOpencode);
    return () => {
      offChanged();
      clearInterval(heartbeat);
      clearInterval(rescan);
      clearTimeout(monthTimer);
      clearTimeout(opencodeTimer);
      for (const res of streams) {
        try {
          res.end();
        } catch {
          // The socket is already gone; nothing left to release.
        }
      }
      streams.clear();
    };
  }, 'token-ledger: aggregation feeds');

  // Every request awaits this, so a freshly opened GUI never flashes a zero
  // that the first cold scan is about to replace.
  refreshLive();
  const firstScan = (async () => {
    try {
      await scanCold();
    } catch (error) {
      logger.warn(`initial ledger scan failed: ${String(error)}`);
    }
    publish();
  })();

  /**
   * Serve one request against the ledger.
   * @param req - the incoming request.
   * @param res - the response this route owns for its whole lifecycle.
   */
  async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405;
      res.setHeader('allow', 'GET, HEAD');
      res.end();
      return;
    }
    await firstScan;
    res.setHeader('cache-control', 'no-store');
    const streaming = req.url === STREAM_ROUTE || req.url?.startsWith(`${STREAM_ROUTE}?`) === true;
    if (streaming) {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('connection', 'keep-alive');
      res.setHeader('x-accel-buffering', 'no');
      res.flushHeaders?.();
      res.write(`retry: 3000\nevent: ledger\ndata: ${JSON.stringify(payload())}\n\n`);
      streams.add(res);
      const drop = () => {
        streams.delete(res);
      };
      res.on('close', drop);
      res.on('error', drop);
      return;
    }
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(payload()));
  }

  ctx.effect(() => {
    const offSummary = ctx.webServer.register({ kind: 'exact', path: SUMMARY_ROUTE, handler: handle });
    const offStream = ctx.webServer.register({ kind: 'exact', path: STREAM_ROUTE, handler: handle });
    return () => {
      offSummary();
      offStream();
    };
  }, 'token-ledger: routes');

  logger.info('token ledger online');
}
