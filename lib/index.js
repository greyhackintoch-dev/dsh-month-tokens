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
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { matchOpencodeKey, matchWorkbuddyKeys, parseOpencodeAuthKeys, parseWorkbuddyModelKeys, resolveTrackedKeys } from './identity.js';
import { UNATTRIBUTED, createScanState, dayKeyOf, listSessionLogs, parseBucketKey, scanSessionLog } from './attribution.js';
import { SNAPSHOT_SCHEMA, aggregateOf, createAggregateStore, normalizeSnapshot, startCollector } from './collector.js';

/** Exact route serving the ledger as one JSON snapshot. */
const SUMMARY_ROUTE = '/token-ledger/summary';
/** Exact route serving the ledger as a server-sent-event stream. */
const STREAM_ROUTE = '/token-ledger/stream';
/** Keep-alive comment cadence, so idle intermediaries do not drop a quiet stream. */
const HEARTBEAT_MS = 25_000;
/** Cold-session rescan cadence; live sessions arrive through the change feed. */
const RESCAN_MS = 60_000;
/** Poll cadence for the third-party readers — their rows land per completed call. */
const THIRD_PARTY_POLL_MS = 60_000;
/** opencode's database, relative to the home directory. */
const OPENCODE_DB_SUBPATH = '.local/share/opencode/opencode.db';
/**
 * opencode's credential store, relative to the home directory.
 *
 * Unlike DSH, which stores a *reference* and resolves it through the credential
 * service, opencode keeps the raw key per provider. Fingerprinting that value is
 * the only way to answer the question this ledger actually asks — "is opencode's
 * DeepSeek traffic *my* key's, or a colleague's?" — and it is safe because what
 * comes back out is a hash. See `lib/identity.js`.
 */
const OPENCODE_AUTH_SUBPATH = '.local/share/opencode/auth.json';
/** The providers whose opencode usage belongs to this ledger by default. */
const OPENCODE_DEFAULT_PROVIDERS = ['deepseek'];
/**
 * Pen's credential store, relative to the home directory.
 *
 * Measured as the *same shape* as opencode's `auth.json`
 * (`{ provider: { type, key } }`), so it is read with the same parser rather
 * than a second one that would drift from it.
 */
const PEN_AUTH_SUBPATH = '.pencil/agent-auth';
/** Pen's session records, one JSON object per line. */
const PEN_SESSIONS_SUBPATH = '.pencil/pi-sessions';
/** The providers whose Pen usage belongs to this ledger by default. */
const PEN_DEFAULT_PROVIDERS = ['deepseek'];
/**
 * WorkBuddy's configured providers, relative to the home directory.
 *
 * A list, not a provider-keyed map — hence its own parser
 * (`parseWorkbuddyModelKeys`).
 */
const WORKBUDDY_MODELS_SUBPATH = '.workbuddy/models.json';
/** WorkBuddy's session records, nested one directory per project. */
const WORKBUDDY_PROJECTS_SUBPATH = '.workbuddy/projects';
/**
 * How WorkBuddy addresses one of its own configured providers.
 *
 * Measured: every row paid for by a `models.json` entry carries
 * `providerData.requestModelId === 'custom-local:<id>'`. This prefix is the
 * whole reason a usage row with no key in it can be joined to a credential —
 * see DESIGN §4.2.2.
 */
const WORKBUDDY_CUSTOM_PREFIX = 'custom-local:';
/** The disjoint prompt-side and completion buckets a provider reports. */
const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
/**
 * SQL counting opencode rows that carry a readable token field.
 *
 * "Has readable fields" is deliberately not "spent something": a settlement
 * that genuinely billed nothing is a real observation, while one whose fields
 * were all renamed is the structural change `drift` exists to report. Summing
 * the buckets would conflate the two and raise a false alarm on an empty month.
 */
const READABLE_TOKENS_SQL = `SUM(CASE WHEN json_type(data, '$.tokens.input') IS NOT NULL
       OR json_type(data, '$.tokens.output') IS NOT NULL
       OR json_type(data, '$.tokens.reasoning') IS NOT NULL
       OR json_type(data, '$.tokens.cache.read') IS NOT NULL
       OR json_type(data, '$.tokens.cache.write') IS NOT NULL
     THEN 1 ELSE 0 END)`;
/** The roles that decide which halves of the cross-machine join run here. */
const ROLES = ['local', 'reporter', 'aggregator', 'both'];
/** The aggregator listener's default port, kept off the GUI's own. */
const DEFAULT_COLLECTOR_PORT = 3939;
/** How long a peer may stay silent before its figures are flagged, not dropped. */
const DEFAULT_STALE_AFTER_HOURS = 24;
/** The aggregator's own persistence, relative to the DSH home. */
const LEDGER_SUBPATH = 'token-ledger';
const AGGREGATE_FILE = 'aggregate.json';
/** The per-install anonymous id, relative to the DSH home. */
const ANONYMOUS_ID_FILE = '.anonymous-user-id';
/**
 * How long one log-scan slice may hold the event loop before yielding.
 *
 * A cold scan of a real 80-session home measures ~430ms of decompression, and
 * every millisecond of it is synchronous. Draining it in one turn would stall
 * the projection change feed, the open SSE streams, and every in-flight HTTP
 * request for that whole window, so the scan is sliced and yields between
 * sessions. 50ms is the largest slice that stays under a dropped-frame budget
 * on a 60Hz client while leaving the cold scan at roughly a dozen turns.
 */
const TRACKED_SCAN_BUDGET_MS = 50;
/** A report is a few kilobytes; anything slower than this is a dead peer. */
const REPORT_TIMEOUT_MS = 10_000;

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
 * Total tokens across a `{ key: bucketSet }` map.
 * @param map - a day-keyed or model-keyed bucket map.
 * @returns total tokens.
 */
function sumBucketMap(map) {
  let total = 0;
  for (const buckets of Object.values(map)) total += sumBuckets(buckets);
  return total;
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
                ${READABLE_TOKENS_SQL} AS readable,
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
    if (messages > 0 && count(row.readable) === 0) {
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
 * Read opencode's usage for ONE provider, bucketed by local day and model.
 *
 * `readOpencodeMonth` answers "how much did opencode spend on the providers
 * this ledger watches", which is a machine-scoped question. Attribution needs a
 * key-scoped one, and it needs the same shape the session-log fold produces —
 * day-keyed and model-keyed buckets — so that an opencode row can be added to a
 * key's month without inventing a second vocabulary or a second period.
 *
 * Two deliberate choices:
 *
 *   - **Local dates, computed in SQL.** `date(time_created/1000, 'unixepoch',
 *     'localtime')` is the same calendar day `dayKeyOf` computes from an event
 *     timestamp, so an opencode row and a session-log row land in the same
 *     bucket. Bucketing in UTC here would file a late-evening call under the
 *     next day for anyone east of Greenwich.
 *   - **`totals` is all-time, `days`/`models` are month-scoped**, matching
 *     `monthViewOf`'s contract exactly. Measured cost on a real store: 32 ms
 *     grouped, 22 ms ungrouped, so the second figure is affordable.
 *
 * @param options - database path, the single provider, the month start, and an injectable sqlite loader.
 * @returns one of `ok`, `absent`, `drift`, `unavailable`, or `error`.
 */
export async function readOpencodeAttribution(options) {
  const { dbPath, provider, monthStart, sqliteLoader = loadSqlite } = options;
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
    const aggregates = `COUNT(*) AS messages,
        ${READABLE_TOKENS_SQL} AS readable,
        COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS uncachedInput,
        COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS output,
        COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
        COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS cacheRead,
        COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cacheWrite`;
    const scope = `FROM message
       WHERE json_extract(data, '$.role') = 'assistant'
         AND json_extract(data, '$.providerID') = ?`;
    const bucketsOf = (row) => ({
      uncachedInputTokens: count(row.uncachedInput),
      outputTokens: count(row.output) + count(row.reasoning),
      cacheReadTokens: count(row.cacheRead),
      cacheWriteTokens: count(row.cacheWrite),
    });

    const rows = db
      .prepare(
        `SELECT date(time_created/1000, 'unixepoch', 'localtime') AS day,
                json_extract(data, '$.modelID') AS model,
                ${aggregates}
           ${scope}
           AND time_created >= ?
          GROUP BY day, model`,
      )
      .all(provider, monthStart);
    const all = db.prepare(`SELECT ${aggregates} ${scope}`).get(provider);
    const readableRow = db.prepare(`SELECT ${READABLE_TOKENS_SQL} AS readable ${scope}`).get(provider);

    const days = Object.create(null);
    const models = Object.create(null);
    let messages = 0;
    let undated = 0;
    for (const row of rows) {
      const buckets = bucketsOf(row);
      const model = typeof row.model === 'string' && row.model !== '' ? row.model : 'unknown';
      addInto((models[model] ??= zeroBuckets()), buckets);
      if (typeof row.day === 'string' && row.day !== '') {
        addInto((days[row.day] ??= zeroBuckets()), buckets);
      } else {
        // A row whose timestamp cannot form a date has no month, so filing it
        // under a guessed one would move real tokens across a boundary. Count
        // it so the omission is visible instead of silent.
        undated += count(row.messages);
      }
      messages += count(row.messages);
    }
    const totals = bucketsOf(all);
    if (messages > 0 && count(readableRow.readable) === 0) {
      return { state: 'drift', message: `${String(messages)} messages carried no readable token fields`, messages };
    }
    return {
      state: 'ok',
      provider,
      days,
      models,
      totals,
      messages,
      ...(undated === 0 ? {} : { undated }),
      fetchedAt: Date.now(),
    };
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
 * Every `.jsonl` file under one directory.
 *
 * Pen writes a flat directory; WorkBuddy nests one directory per project and
 * puts subagent transcripts in a `subagents/` child, so the walk has to be
 * recursive for one and not the other. An unreadable directory yields nothing
 * rather than throwing: "there is no record here" is a state the caller
 * reports, not a crash.
 * @param dir - directory to walk.
 * @param recursive - whether to descend into subdirectories.
 * @returns absolute paths, sorted so the read order is stable across runs.
 */
function listJsonlFiles(dir, recursive) {
  const found = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(full);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Decode every JSON line of one file.
 *
 * A line that will not parse is skipped rather than fatal — an append-only log
 * can be caught mid-write — but the count is returned, because a file that is
 * *entirely* unparsable is how a structural change announces itself and must
 * not be mistaken for an empty month.
 * @param file - the file to read.
 * @returns the records plus the unreadable-line count, or why the file could not be read.
 */
function readJsonlFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, message: String(error?.code ?? error) };
  }
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      malformed += 1;
    }
  }
  return { ok: true, records, malformed };
}

/**
 * Whether a file held content but not one parseable line.
 *
 * This is the difference between a torn append and a format that is no longer
 * JSONL at all: a crash can leave one partial trailing line, which is not worth
 * a warning, but a file whose every line fails to parse is a structural change
 * and must not read as an empty month.
 * @param parsed - the result of {@link readJsonlFile}.
 * @returns whether the file is unreadable garbage.
 */
function isGarbageFile(parsed) {
  return parsed.ok && parsed.malformed > 0 && parsed.records.length === 0;
}

/**
 * One non-negative integer token field, or `undefined` when it is not one.
 * @param value - the raw field.
 * @returns the count, or `undefined`.
 */
function tokenField(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

/**
 * Pen's per-day, per-model usage for one provider.
 *
 * Pi-ai's usage object is additive over four buckets and already carries
 * reasoning inside `output` — measured on all 83 real records,
 * `input + output + cacheRead + cacheWrite === totalTokens` holds exactly, and
 * `reasoning <= output` always. So, unlike opencode, **reasoning must not be
 * added**: doing so would inflate every Pen row (§F19).
 * @param options - session directory, the single provider, and the month start.
 * @returns one of `ok`, `absent`, `drift`, or `error`.
 */
export async function readPenAttribution(options) {
  const { sessionsDir, provider, monthStart } = options;
  if (!existsSync(sessionsDir)) return { state: 'absent', message: sessionsDir };
  const files = listJsonlFiles(sessionsDir, false);
  if (files.length === 0) return { state: 'absent', message: sessionsDir };

  const days = Object.create(null);
  const models = Object.create(null);
  const totals = zeroBuckets();
  let messages = 0;
  let readable = 0;
  let undated = 0;
  let unreadableFiles = 0;
  let garbageFiles = 0;
  try {
    for (const file of files) {
      const parsed = readJsonlFile(file);
      if (!parsed.ok) {
        unreadableFiles += 1;
        continue;
      }
      if (isGarbageFile(parsed)) garbageFiles += 1;
      for (const record of parsed.records) {
        const message = record?.message;
        if (record?.type !== 'message' || message === null || typeof message !== 'object') continue;
        if (message.role !== 'assistant' || message.provider !== provider) continue;
        messages += 1;
        const usage = message.usage;
        if (usage === null || typeof usage !== 'object') continue;
        const buckets = penBuckets(usage);
        if (buckets === undefined) continue;
        readable += 1;
        addInto(totals, buckets);
        // `days` and `models` are the *month* view, `totals` the all-time one —
        // the same contract `monthViewOf` states for the log fold. A model
        // breakdown that spanned all time beside a month headline would be two
        // periods presented as one.
        if (message.timestamp < monthStart) continue;
        const model = typeof message.model === 'string' && message.model !== '' ? message.model : 'unknown';
        addInto((models[model] ??= zeroBuckets()), buckets);
        const day = dayKeyOf(message.timestamp);
        if (day === null) {
          undated += 1;
          continue;
        }
        addInto((days[day] ??= zeroBuckets()), buckets);
      }
    }
  } catch (error) {
    return { state: 'error', message: String(error) };
  }
  if (readable === 0 && (messages > 0 || garbageFiles > 0)) {
    return { state: 'drift', message: `${String(messages)} messages carried no readable usage fields`, messages };
  }
  if (unreadableFiles === files.length) {
    return { state: 'error', message: `none of ${String(files.length)} session files could be read` };
  }
  return {
    state: 'ok',
    provider,
    days,
    models,
    totals,
    messages,
    ...(undated === 0 ? {} : { undated }),
    fetchedAt: Date.now(),
  };
}

/**
 * Pen's whole month for the watched providers — the machine-scoped row.
 *
 * Not key-scoped, and deliberately so: it is where Pen usage that turns out to
 * belong to a colleague's key stays visible (§4.2.1's rule for opencode).
 * @param options - session directory, the watched providers, and the month start.
 * @returns one of `ok`, `absent`, `drift`, or `error`.
 */
export async function readPenMonth(options) {
  const { sessionsDir, providers, monthStart } = options;
  const seen = new Set(providers);
  if (!existsSync(sessionsDir)) return { state: 'absent', message: sessionsDir };
  const files = listJsonlFiles(sessionsDir, false);
  if (files.length === 0) return { state: 'absent', message: sessionsDir };

  const totals = zeroBuckets();
  let messages = 0;
  let readable = 0;
  let unreadableFiles = 0;
  let garbageFiles = 0;
  try {
    for (const file of files) {
      const parsed = readJsonlFile(file);
      if (!parsed.ok) {
        unreadableFiles += 1;
        continue;
      }
      if (isGarbageFile(parsed)) garbageFiles += 1;
      for (const record of parsed.records) {
        const message = record?.message;
        if (record?.type !== 'message' || message === null || typeof message !== 'object') continue;
        if (message.role !== 'assistant' || !seen.has(message.provider)) continue;
        if (typeof message.timestamp !== 'number' || message.timestamp < monthStart) continue;
        messages += 1;
        const buckets = penBuckets(message.usage);
        if (buckets === undefined) continue;
        readable += 1;
        addInto(totals, buckets);
      }
    }
  } catch (error) {
    return { state: 'error', message: String(error) };
  }
  if (readable === 0 && (messages > 0 || garbageFiles > 0)) {
    return { state: 'drift', message: `${String(messages)} messages carried no readable usage fields`, messages };
  }
  if (unreadableFiles === files.length) {
    return { state: 'error', message: `none of ${String(files.length)} session files could be read` };
  }
  return { state: 'ok', totals, messages, fetchedAt: Date.now() };
}

/**
 * One Pen usage object, in this ledger's buckets.
 *
 * Returns `undefined` when none of the four fields is readable, so a renamed
 * structure is distinguishable from a settlement that genuinely billed nothing.
 * @param usage - the `message.usage` value.
 * @returns the bucket set, or `undefined`.
 */
function penBuckets(usage) {
  if (usage === null || typeof usage !== 'object') return undefined;
  const input = tokenField(usage.input);
  const output = tokenField(usage.output);
  // Reasoning is already counted inside `output`; never added again (F19).
  const cacheRead = tokenField(usage.cacheRead);
  const cacheWrite = tokenField(usage.cacheWrite);
  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) return undefined;
  return {
    uncachedInputTokens: input ?? 0,
    outputTokens: output ?? 0,
    cacheReadTokens: cacheRead ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
  };
}

/**
 * WorkBuddy's per-day, per-model usage for the model ids a tracked key owns.
 *
 * DeepSeek's native wire shape, and its `completion_tokens_details
 * .reasoning_tokens` is a *subset* of `completion_tokens` — measured on all 122
 * real rows, `reasoning_tokens <= completion_tokens` always — so reasoning must
 * not be added here either (§F19). The additive identity that does hold, on
 * every row, is `miss + hit + write + completion === total_tokens`.
 *
 * `prompt_tokens` (and `usage.inputTokens`) is the *sum* including cache hits,
 * so it is never used as uncached input; the four buckets come from the
 * `prompt_cache_*` fields.
 *
 * The population is rows carrying a usage envelope, which is what makes the
 * `drift` test meaningful: a rename *inside* `rawUsage` still leaves the
 * envelope in place, so it is counted, read as zero, and reported rather than
 * silently dropping the month. A rename *of* `rawUsage` itself would leave no
 * envelope to count and would read as an empty month — a residual blind spot,
 * accepted because the alternative (treating addressed-but-unsettled events as
 * evidence of drift) fires on sessions where every call was merely interrupted.
 * @param options - projects directory, the model ids that join to the tracked key, and the month start.
 * @returns one of `ok`, `absent`, `drift`, or `error`.
 */
export async function readWorkbuddyAttribution(options) {
  const { projectsDir, modelIds, monthStart } = options;
  const wanted = new Set(modelIds.map((id) => `${WORKBUDDY_CUSTOM_PREFIX}${id}`));
  if (!existsSync(projectsDir)) return { state: 'absent', message: projectsDir };
  const files = listJsonlFiles(projectsDir, true);
  if (files.length === 0) return { state: 'absent', message: projectsDir };

  const days = Object.create(null);
  const models = Object.create(null);
  const totals = zeroBuckets();
  let requests = 0;
  let readable = 0;
  let undated = 0;
  let unreadableFiles = 0;
  let garbageFiles = 0;
  try {
    for (const file of files) {
      const parsed = readJsonlFile(file);
      if (!parsed.ok) {
        unreadableFiles += 1;
        continue;
      }
      if (isGarbageFile(parsed)) garbageFiles += 1;
      for (const record of parsed.records) {
        const providerData = record?.providerData;
        if (providerData === null || typeof providerData !== 'object') continue;
        if (!wanted.has(providerData.requestModelId)) continue;
        // `providerData` rides *every* event of one conversation — measured:
        // `function_call_result` (27) and `reasoning` (15) carry it without any
        // usage. Only a settlement carries a usage envelope, and only a
        // settlement is a request, so this is the population `messages` counts.
        if (providerData.rawUsage === null || typeof providerData.rawUsage !== 'object') continue;
        requests += 1;
        const buckets = workbuddyBuckets(providerData.rawUsage);
        if (buckets === undefined) continue;
        readable += 1;
        addInto(totals, buckets);
        // Month view and all-time view, as in the Pen reader.
        if (record.timestamp < monthStart) continue;
        const model = typeof providerData.model === 'string' && providerData.model !== '' ? providerData.model : 'unknown';
        addInto((models[model] ??= zeroBuckets()), buckets);
        const day = dayKeyOf(record.timestamp);
        if (day === null) {
          undated += 1;
          continue;
        }
        addInto((days[day] ??= zeroBuckets()), buckets);
      }
    }
  } catch (error) {
    return { state: 'error', message: String(error) };
  }
  if (readable === 0 && (requests > 0 || garbageFiles > 0)) {
    return { state: 'drift', message: `${String(requests)} requests carried no readable usage fields`, messages: requests };
  }
  if (unreadableFiles === files.length) {
    return { state: 'error', message: `none of ${String(files.length)} session files could be read` };
  }
  return {
    state: 'ok',
    modelIds,
    days,
    models,
    totals,
    messages: requests,
    ...(undated === 0 ? {} : { undated }),
    fetchedAt: Date.now(),
  };
}

/**
 * WorkBuddy's whole month for the providers it was configured with — the
 * machine-scoped row.
 *
 * Scoped to `custom-local:` rows on purpose. WorkBuddy's own gateway routes
 * (`auto`, `hy3`) are billed to WorkBuddy's backend key, not to any credential
 * this machine holds, so folding them into a row titled "WorkBuddy" would
 * report someone else's spend under the user's product name. Measured on the
 * real store, that is 100 of 122 rows.
 * @param options - projects directory and the month start.
 * @returns one of `ok`, `absent`, `drift`, or `error`.
 */
export async function readWorkbuddyMonth(options) {
  const { projectsDir, monthStart } = options;
  if (!existsSync(projectsDir)) return { state: 'absent', message: projectsDir };
  const files = listJsonlFiles(projectsDir, true);
  if (files.length === 0) return { state: 'absent', message: projectsDir };

  const totals = zeroBuckets();
  let requests = 0;
  let readable = 0;
  let unreadableFiles = 0;
  let garbageFiles = 0;
  try {
    for (const file of files) {
      const parsed = readJsonlFile(file);
      if (!parsed.ok) {
        unreadableFiles += 1;
        continue;
      }
      if (isGarbageFile(parsed)) garbageFiles += 1;
      for (const record of parsed.records) {
        const providerData = record?.providerData;
        if (providerData === null || typeof providerData !== 'object') continue;
        if (typeof providerData.requestModelId !== 'string') continue;
        if (!providerData.requestModelId.startsWith(WORKBUDDY_CUSTOM_PREFIX)) continue;
        if (typeof record.timestamp !== 'number' || record.timestamp < monthStart) continue;
        // See the attribution reader: only a settlement carries a usage
        // envelope, and only a settlement is a request.
        if (providerData.rawUsage === null || typeof providerData.rawUsage !== 'object') continue;
        requests += 1;
        const buckets = workbuddyBuckets(providerData.rawUsage);
        if (buckets === undefined) continue;
        readable += 1;
        addInto(totals, buckets);
      }
    }
  } catch (error) {
    return { state: 'error', message: String(error) };
  }
  if (readable === 0 && (requests > 0 || garbageFiles > 0)) {
    return { state: 'drift', message: `${String(requests)} requests carried no readable usage fields`, messages: requests };
  }
  if (unreadableFiles === files.length) {
    return { state: 'error', message: `none of ${String(files.length)} session files could be read` };
  }
  return { state: 'ok', totals, messages: requests, fetchedAt: Date.now() };
}

/**
 * One WorkBuddy usage envelope, in this ledger's buckets.
 *
 * Returns `undefined` when nothing readable is present, so a row that carries
 * no usage is not counted as a zero-token request.
 * @param rawUsage - the `providerData.rawUsage` value.
 * @returns the bucket set, or `undefined`.
 */
function workbuddyBuckets(rawUsage) {
  if (rawUsage === null || typeof rawUsage !== 'object') return undefined;
  const miss = tokenField(rawUsage.prompt_cache_miss_tokens);
  const hit = tokenField(rawUsage.prompt_cache_hit_tokens);
  const write = tokenField(rawUsage.prompt_cache_write_tokens);
  // Reasoning tokens are a subset of completion_tokens here; never added.
  const completion = tokenField(rawUsage.completion_tokens);
  if (miss === undefined && hit === undefined && write === undefined && completion === undefined) return undefined;
  return {
    uncachedInputTokens: miss ?? 0,
    outputTokens: completion ?? 0,
    cacheReadTokens: hit ?? 0,
    // Absent on a direct call, which is exactly "wrote nothing to cache".
    cacheWriteTokens: write ?? 0,
  };
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
 * This install's DSH home.
 *
 * Honours `DSH_HOME` because a profile can relocate the whole home, and the
 * session logs this ledger reads are addressed relative to it.
 * @returns the absolute home directory.
 */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/**
 * The stable identity of this install, used as the aggregator's per-instance
 * key.
 *
 * The anonymous id file is first-party and shared with the provider adapters,
 * so two DSH halves on one machine agree on who they are. When it is missing
 * the value must still be **stable across restarts**: a per-process random id
 * would make the aggregator treat one machine as a new machine every boot and
 * double its usage, which is worse than a coarser identity. So the fallback is
 * a hash of facts that do not change while the install stays put.
 * @returns a stable instance id.
 */
function instanceIdentity() {
  try {
    const stored = readFileSync(join(dshHome(), ANONYMOUS_ID_FILE), 'utf8').trim();
    if (stored.length > 0) return stored;
  } catch {
    // No stored id: fall through to the derived one.
  }
  return `host-${createHash('sha256').update(hostname()).update('\0').update(homedir()).digest('hex').slice(0, 16)}`;
}

/**
 * Normalize an aggregator address to the exact ingest endpoint.
 *
 * Accepting both the bare origin and the full endpoint keeps the config
 * forgiving without guessing: anything already naming a path is taken as
 * written.
 * @param raw - the configured address.
 * @returns the ingest URL, or `undefined` when unconfigured.
 */
function ingestUrlOf(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  const trimmed = raw.trim().replace(/\/+$/u, '');
  return trimmed.endsWith('/ingest') ? trimmed : `${trimmed}/ingest`;
}

/**
 * Host plugin body: fold every session's usage into one published month total.
 * @param ctx - host context carrying the persistence, projection, and webserver services.
 */
export function apply(ctx, config) {
  const logger = ctx.logger('token-ledger');
  /**
   * One on-disk location, resolved config → environment → home-relative default.
   *
   * Three levels rather than two because all three are real setups: a store
   * that lives elsewhere is configured, a per-machine override belongs in the
   * environment, and the shipped default is just where the product puts it.
   * Every reader's path resolves through here so none of them can drift into a
   * different precedence.
   * @param configured - the config value, of unknown shape.
   * @param envName - the environment variable that overrides the default.
   * @param subpath - the default, relative to the home directory.
   * @returns the resolved path.
   */
  const pathSetting = (configured, envName, subpath) =>
    typeof configured === 'string' && configured !== '' ? configured : process.env[envName] || join(homedir(), subpath);
  /**
   * One provider allow-list, falling back to the reader's own default.
   * @param configured - the config value, of unknown shape.
   * @param fallback - the default list.
   * @returns the resolved provider ids.
   */
  const providerSetting = (configured, fallback) =>
    Array.isArray(configured) && configured.length > 0
      ? configured.filter((entry) => typeof entry === 'string' && entry !== '')
      : fallback;
  /** Where opencode lives and which of its providers belong to this ledger. */
  const opencodeSettings = {
    dbPath: pathSetting(config?.opencodeDbPath, 'DSH_TOKEN_LEDGER_OPENCODE_DB', OPENCODE_DB_SUBPATH),
    providers: providerSetting(config?.opencodeProviders, OPENCODE_DEFAULT_PROVIDERS),
    // Overridable for the same two reasons the database path is: a store that
    // lives elsewhere is a real setup, and a test that cannot point the read at
    // a fixture would have to touch the developer's own credentials.
    authPath: pathSetting(config?.opencodeAuthPath, 'DSH_TOKEN_LEDGER_OPENCODE_AUTH', OPENCODE_AUTH_SUBPATH),
  };
  /**
   * Where Pen keeps its credential and its session records.
   *
   * `agent-auth` is measured to be the same `{ provider: { type, key } }` shape
   * as opencode's `auth.json`, so it is parsed by the same function rather than
   * by a second one that could drift.
   */
  const penSettings = {
    authPath: pathSetting(config?.penAuthPath, 'DSH_TOKEN_LEDGER_PEN_AUTH', PEN_AUTH_SUBPATH),
    sessionsDir: pathSetting(config?.penSessionsDir, 'DSH_TOKEN_LEDGER_PEN_SESSIONS', PEN_SESSIONS_SUBPATH),
    providers: providerSetting(config?.penProviders, PEN_DEFAULT_PROVIDERS),
  };
  /** Where WorkBuddy keeps its configured providers and its session records. */
  const workbuddySettings = {
    modelsPath: pathSetting(config?.workbuddyModelsPath, 'DSH_TOKEN_LEDGER_WORKBUDDY_MODELS', WORKBUDDY_MODELS_SUBPATH),
    projectsDir: pathSetting(config?.workbuddyProjectsDir, 'DSH_TOKEN_LEDGER_WORKBUDDY_PROJECTS', WORKBUDDY_PROJECTS_SUBPATH),
  };
  /**
   * The cross-machine half's configuration.
   *
   * Every field is optional, and the defaults together reproduce the
   * pre-existing single-machine behaviour exactly: nothing tracked, no
   * listener, no reports, and no session log read. That last one matters as
   * much as the others — with no tracked key there is nothing to attribute, so
   * scanning logs would be pure I/O for a figure nobody asked for.
   */
  const ledger = {
    trackKeys: Array.isArray(config?.trackKeys) ? config.trackKeys : [],
    role: ROLES.includes(config?.role) ? config.role : 'local',
    collectorPort: Number.isInteger(config?.collectorPort) ? config.collectorPort : DEFAULT_COLLECTOR_PORT,
    collectorHost:
      typeof config?.collectorHost === 'string' && config.collectorHost !== '' ? config.collectorHost : '127.0.0.1',
    collectorToken:
      typeof config?.collectorToken === 'string' && config.collectorToken !== ''
        ? config.collectorToken
        : process.env.DSH_TOKEN_LEDGER_TOKEN ?? '',
    ingestUrl: ingestUrlOf(config?.aggregatorUrl),
    instanceLabel:
      typeof config?.instanceLabel === 'string' && config.instanceLabel !== '' ? config.instanceLabel : hostname(),
    staleAfterHours:
      typeof config?.staleAfterHours === 'number' && Number.isFinite(config.staleAfterHours) && config.staleAfterHours > 0
        ? config.staleAfterHours
        : DEFAULT_STALE_AFTER_HOURS,
    sessionsDir:
      typeof config?.sessionsDir === 'string' && config.sessionsDir !== ''
        ? config.sessionsDir
        : join(dshHome(), 'sessions'),
    aggregateFile: join(dshHome(), LEDGER_SUBPATH, AGGREGATE_FILE),
  };
  /** Which halves of the join run in this process, derived once from the role. */
  const runs = {
    reporter: ledger.role === 'reporter' || ledger.role === 'both',
    aggregator: ledger.role === 'aggregator' || ledger.role === 'both',
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
  /**
   * Which tracked key opencode's stored credential resolves to.
   *
   * `undefined` means "not decided yet", which is different from a decided
   * "no match": opencode may be spending a colleague's key, and that usage must
   * not be folded into mine — but neither may it be folded in merely because
   * the read has not happened yet.
   */
  let opencodeMatch;
  /**
   * opencode's own usage for the matched provider, in the same day/model shape
   * the session-log fold produces. Kept beside `opencode` rather than inside it
   * because the two answer different questions: `opencode` is this machine's
   * whole opencode month, this is the part of it that is *this key's*.
   */
  let opencodeAttribution = { state: 'absent' };
  /** This month's Pen usage, or why it is missing. */
  let pen = { state: 'loading' };
  /** Which tracked key Pen's stored credential resolves to; see `opencodeMatch`. */
  let penMatch;
  /** Pen's usage for the matched provider, in the shared day/model shape. */
  let penAttribution = { state: 'absent' };
  /** This month's WorkBuddy usage, or why it is missing. */
  let workbuddy = { state: 'loading' };
  /**
   * Which tracked key WorkBuddy's configured providers resolve to, plus the
   * model ids that address it.
   *
   * The ids travel with the match because WorkBuddy's usage rows name a
   * *model*, not a provider: `custom-local:<id>` is the only thing in a row
   * that can be joined back to the credential that paid for it (DESIGN §4.2.2).
   */
  let workbuddyMatch;
  /** WorkBuddy's usage for the matched model ids, in the shared day/model shape. */
  let workbuddyAttribution = { state: 'absent' };
  /**
   * Per-session log-scan state, kept apart from `bySession` on purpose: the
   * projection fold answers "how much this machine spent", the scan answers
   * "which key spent it, on which day, on which model", and a session can
   * legitimately appear in one and not the other (a session whose log was
   * pruned, or one that has not been checkpointed into the cache yet).
   */
  const trackedBySession = new Map();
  /** Resolved tracking targets, and why any of them could not be resolved. */
  let trackedKeys = [];
  let trackedFailures = [];
  /** The folded per-fingerprint view, rebuilt whenever a scan consumes frames. */
  let trackedFold = { entries: new Map(), uncovered: new Set() };
  /** The last published shape, so an idle cycle does not bump the revision. */
  let trackedSignature = '';
  /** A scan is in flight; an overlapping pass would race on the same offsets. */
  let trackedScanning = false;
  /** When the log scan last completed, for the panel's freshness line. */
  let trackedScannedAt = 0;
  /** This install's identity, and the rising sequence its reports carry. */
  const instanceId = instanceIdentity();
  let reportSeq = 0;
  /** Listener and reporter states, published verbatim. */
  let collectorStatus = { state: runs.aggregator ? 'starting' : 'off' };
  let reporterStatus = { state: runs.reporter ? (ledger.ingestUrl === undefined ? 'noUrl' : 'idle') : 'off' };
  /** The snapshot store, when this process is the aggregator. */
  const aggregateStore = runs.aggregator ? createAggregateStore({ file: ledger.aggregateFile }) : undefined;

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
      tools: { opencode, pen, workbuddy },
      sessions: { counted: bySession.size, live: liveIds.size, skippedSeeded, scannedAt },
      // The cross-machine half is appended, never substituted: every field
      // above keeps the meaning it had when this was a single-machine ledger.
      tracked: trackedPayload(),
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

  /**
   * Decide whether opencode is spending *this* key, and read its share if so.
   *
   * opencode keeps the raw key per provider, so a provider name proves nothing:
   * two machines can both say `deepseek` while only one of them holds the key
   * being tracked, and the company account makes that the normal case rather
   * than a hypothetical. The decision is therefore made on the fingerprint, and
   * a provider that does not match is left out of the key's total — its usage
   * stays visible in the machine-wide opencode row, which is the honest place
   * for it.
   */
  async function refreshOpencodeAttribution() {
    if (trackedKeys.length === 0) {
      opencodeMatch = undefined;
      opencodeAttribution = { state: 'absent' };
      return;
    }
    let verdicts;
    try {
      verdicts = parseOpencodeAuthKeys(JSON.parse(readFileSync(opencodeSettings.authPath, 'utf8')));
    } catch (error) {
      // A missing or unreadable store is not a ledger failure: it means
      // opencode cannot be attributed, which is a state the panel can state.
      opencodeMatch = undefined;
      opencodeAttribution = { state: 'unreadable', message: String(error?.code ?? error) };
      return;
    }
    opencodeMatch = matchOpencodeKey({ opencodeKeys: verdicts, keys: trackedKeys });
    if (opencodeMatch === undefined) {
      opencodeAttribution = { state: 'otherKey', providers: verdicts.map((entry) => entry.provider) };
      return;
    }
    try {
      opencodeAttribution = await readOpencodeAttribution({
        dbPath: opencodeSettings.dbPath,
        provider: opencodeMatch.provider,
        monthStart: monthWindow(Date.now()).start,
      });
    } catch (error) {
      opencodeAttribution = { state: 'error', message: String(error) };
    }
  }

  /**
   * Re-read Pen's month, republishing only on a real movement.
   *
   * Same contract as `refreshOpencode`: `fetchedAt` is excluded from the
   * comparison, because it moves on every poll and would otherwise bump the
   * revision — and re-render every open panel — once a minute forever.
   */
  async function refreshPen() {
    let next;
    try {
      next = await readPenMonth({ ...penSettings, monthStart: monthWindow(Date.now()).start });
    } catch (error) {
      next = { state: 'error', message: String(error) };
    }
    const previous = pen;
    const moved =
      previous.state !== next.state ||
      previous.messages !== next.messages ||
      !sameBuckets(previous.totals, next.totals);
    pen = next;
    if (next.state === 'ok') logger.info(`pen this month: ${String(sumOf(next.totals))} tokens over ${String(next.messages)} messages`);
    else if (next.state !== 'absent') logger.warn(`pen usage unavailable (${next.state}): ${next.message ?? ''}`);
    if (moved) publish();
  }

  /**
   * Decide whether Pen is spending *this* key, and read its share if so.
   *
   * The same question opencode's attribution answers, and deliberately the same
   * code: `agent-auth` is measured to be the identical `{ provider: { type, key } }`
   * shape, so the parser and matcher are reused rather than reimplemented. Only
   * the file is different.
   */
  async function refreshPenAttribution() {
    if (trackedKeys.length === 0) {
      penMatch = undefined;
      penAttribution = { state: 'absent' };
      return;
    }
    let verdicts;
    try {
      verdicts = parseOpencodeAuthKeys(JSON.parse(readFileSync(penSettings.authPath, 'utf8')));
    } catch (error) {
      // A missing or unreadable store is not a ledger failure: it means Pen
      // cannot be attributed, which is a state the panel can state.
      penMatch = undefined;
      penAttribution = { state: 'unreadable', message: String(error?.code ?? error) };
      return;
    }
    penMatch = matchOpencodeKey({ opencodeKeys: verdicts, keys: trackedKeys });
    if (penMatch === undefined) {
      penAttribution = { state: 'otherKey', providers: verdicts.map((entry) => entry.provider) };
      return;
    }
    try {
      penAttribution = await readPenAttribution({
        sessionsDir: penSettings.sessionsDir,
        provider: penMatch.provider,
        monthStart: monthWindow(Date.now()).start,
      });
    } catch (error) {
      penAttribution = { state: 'error', message: String(error) };
    }
  }

  /** Re-read WorkBuddy's month, republishing only on a real movement. */
  async function refreshWorkbuddy() {
    let next;
    try {
      next = await readWorkbuddyMonth({ projectsDir: workbuddySettings.projectsDir, monthStart: monthWindow(Date.now()).start });
    } catch (error) {
      next = { state: 'error', message: String(error) };
    }
    const previous = workbuddy;
    const moved =
      previous.state !== next.state ||
      previous.messages !== next.messages ||
      !sameBuckets(previous.totals, next.totals);
    workbuddy = next;
    if (next.state === 'ok') logger.info(`workbuddy this month: ${String(sumOf(next.totals))} tokens over ${String(next.messages)} requests`);
    else if (next.state !== 'absent') logger.warn(`workbuddy usage unavailable (${next.state}): ${next.message ?? ''}`);
    if (moved) publish();
  }

  /**
   * Decide whether WorkBuddy is spending *this* key, and read its share if so.
   *
   * WorkBuddy's store is a list of its own configured providers, so this uses
   * the sibling parser and the model-id matcher. The decision is still made on
   * the fingerprint: the model ids only say *which rows* to read once the
   * credential has been matched, never whether it matched.
   */
  async function refreshWorkbuddyAttribution() {
    if (trackedKeys.length === 0) {
      workbuddyMatch = undefined;
      workbuddyAttribution = { state: 'absent' };
      return;
    }
    let verdicts;
    try {
      verdicts = parseWorkbuddyModelKeys(JSON.parse(readFileSync(workbuddySettings.modelsPath, 'utf8')));
    } catch (error) {
      workbuddyMatch = undefined;
      workbuddyAttribution = { state: 'unreadable', message: String(error?.code ?? error) };
      return;
    }
    workbuddyMatch = matchWorkbuddyKeys({ workbuddyKeys: verdicts, keys: trackedKeys });
    if (workbuddyMatch === undefined) {
      workbuddyAttribution = { state: 'otherKey', providers: verdicts.map((entry) => entry.provider) };
      return;
    }
    try {
      workbuddyAttribution = await readWorkbuddyAttribution({
        projectsDir: workbuddySettings.projectsDir,
        modelIds: workbuddyMatch.modelIds,
        monthStart: monthWindow(Date.now()).start,
      });
    } catch (error) {
      workbuddyAttribution = { state: 'error', message: String(error) };
    }
  }

  /**
   * The month-scoped view of one tracked key.
   *
   * A key's `totals` are all-time, exactly like the local figure, while `days`
   * and `models` answer the question the month actually asks — which days and
   * which models spent it. Scoping the model breakdown to the month is not
   * symmetry for its own sake: a panel that shows a month headline beside an
   * all-time model split is showing two different periods without saying so.
   * @param entry - one folded key entry.
   * @returns `{ days, models, month }` for the current period.
   */
  function monthViewOf(entry) {
    const prefix = `${period.key}-`;
    const days = {};
    let month = 0;
    for (const [day, buckets] of entry.days) {
      if (!day.startsWith(prefix)) continue;
      days[day] = { ...buckets };
      month += sumBuckets(buckets);
    }
    const models = {};
    const scoped = entry.modelsByMonth.get(period.key);
    if (scoped !== undefined) for (const [model, buckets] of scoped) models[model] = { ...buckets };
    return { days, models, month };
  }

  /** Whether opencode's stored credential is this entry's key. */
  function opencodeBelongsTo(entry) {
    return opencodeAttribution.state === 'ok'
      && opencodeMatch !== undefined
      && opencodeMatch.key.fingerprint === entry.fingerprint;
  }

  /** Whether Pen's stored credential is this entry's key. */
  function penBelongsTo(entry) {
    return penAttribution.state === 'ok'
      && penMatch !== undefined
      && penMatch.key.fingerprint === entry.fingerprint;
  }

  /** Whether WorkBuddy's configured providers are this entry's key. */
  function workbuddyBelongsTo(entry) {
    return workbuddyAttribution.state === 'ok'
      && workbuddyMatch !== undefined
      && workbuddyMatch.key.fingerprint === entry.fingerprint;
  }

  /**
   * Every third-party record that is *this* key's, in a stable order.
   *
   * The three readers answer the same two questions — "is this tool on my key"
   * and "what did it spend" — and return the same day/model shape, so they fold
   * through one loop rather than three copies of it. A tool whose credential did
   * not match is simply absent from this list; its usage stays in the
   * machine-scoped row, which is the honest place for another key's spend.
   * @param entry - one folded key entry.
   * @returns the attributions belonging to this key.
   */
  function sourcesFor(entry) {
    const sources = [];
    if (opencodeBelongsTo(entry)) sources.push(opencodeAttribution);
    if (penBelongsTo(entry)) sources.push(penAttribution);
    if (workbuddyBelongsTo(entry)) sources.push(workbuddyAttribution);
    return sources;
  }

  /**
   * The tracked view of one key, with every matching third-party record folded
   * in.
   *
   * Those rows land in the same day and model buckets the session log produces,
   * so the key's month stays one number with one period. That matters beyond
   * tidiness: the reporter ships this same view, so a peer's total agrees with
   * the one shown locally instead of quietly shrinking the moment an aggregator
   * takes over.
   *
   * `month` is the sum of `days` rather than an adjustment to it, because a
   * headline that is not the sum of its own breakdown is exactly the kind of
   * discrepancy nobody can debug six weeks later.
   * @param entry - one folded key entry.
   * @returns `{ days, models, month }` for the current period.
   */
  function attributedView(entry) {
    const view = monthViewOf(entry);
    const sources = sourcesFor(entry);
    if (sources.length === 0) return view;
    const prefix = `${period.key}-`;
    const days = { ...view.days };
    const models = { ...view.models };
    for (const source of sources) {
      for (const [day, buckets] of Object.entries(source.days)) {
        if (!day.startsWith(prefix)) continue;
        addInto((days[day] ??= zeroBuckets()), buckets);
      }
      for (const [model, buckets] of Object.entries(source.models)) {
        addInto((models[model] ??= zeroBuckets()), buckets);
      }
    }
    let month = 0;
    for (const buckets of Object.values(days)) month += sumBuckets(buckets);
    return { days, models, month };
  }

  /** A key's all-time buckets, every matching third-party record included. */
  function attributedTotals(entry) {
    const totals = { ...entry.totals };
    for (const source of sourcesFor(entry)) addInto(totals, source.totals);
    return totals;
  }

  /**
   * Fold every session's attributed buckets into one entry per fingerprint.
   *
   * The session scan states are keyed by `(owner, day, model)` because that is
   * what the log can say per event; this collapses them to the three views the
   * panel and the wire each need. Untracked usage is deliberately dropped here
   * rather than folded into a bucket of its own: it is already visible as
   * `uncovered`, and adding it to a key's total is the one arithmetic error
   * this whole feature exists to prevent.
   */
  function foldTracked() {
    const entries = new Map();
    const uncovered = new Set();
    for (const state of trackedBySession.values()) {
      for (const [key, buckets] of Object.entries(state.buckets)) {
        const { owner, day, model } = parseBucketKey(key);
        if (owner === UNATTRIBUTED) continue;
        let entry = entries.get(owner);
        if (entry === undefined) {
          entry = {
            fingerprint: owner,
            totals: zeroBuckets(),
            days: new Map(),
            modelsByMonth: new Map(),
          };
          entries.set(owner, entry);
        }
        addInto(entry.totals, buckets);
        let dayTotals = entry.days.get(day);
        if (dayTotals === undefined) {
          dayTotals = zeroBuckets();
          entry.days.set(day, dayTotals);
        }
        addInto(dayTotals, buckets);
        const monthKey = day.slice(0, 7);
        let models = entry.modelsByMonth.get(monthKey);
        if (models === undefined) {
          models = new Map();
          entry.modelsByMonth.set(monthKey, models);
        }
        let modelTotals = models.get(model);
        if (modelTotals === undefined) {
          modelTotals = zeroBuckets();
          models.set(model, modelTotals);
        }
        addInto(modelTotals, buckets);
      }
      for (const provider of Object.keys(state.uncovered)) uncovered.add(provider);
    }
    // Configured order decides listing order, and a configured key that has
    // spent nothing still appears: "tracked and empty" is a fact the panel
    // must be able to state, and an absent row cannot state it.
    const ordered = new Map();
    for (const tracked of trackedKeys) {
      const entry = entries.get(tracked.fingerprint) ?? {
        fingerprint: tracked.fingerprint,
        totals: zeroBuckets(),
        days: new Map(),
        modelsByMonth: new Map(),
      };
      ordered.set(tracked.fingerprint, {
        ...entry,
        short: tracked.short,
        ref: tracked.ref,
        providers: tracked.providers,
      });
    }
    trackedFold = { entries: ordered, uncovered };
  }

  /**
   * Resolve the configured refs to fingerprints.
   *
   * The credential service is fetched rather than injected because it is not
   * mounted in every profile, and this ledger must work on a plain `web`
   * composition that stores its key in the environment. Resolution runs every
   * cycle so a key rotated at runtime reaches the next scan without a restart.
   * Failures are kept verbatim and published: a ref that is configured but
   * unresolvable is a fact the panel has to be able to report.
   */
  async function refreshTrackedKeys() {
    try {
      const resolved = await resolveTrackedKeys({
        credentials: ctx.get('credentials'),
        trackKeys: ledger.trackKeys,
        env: process.env,
      });
      trackedKeys = resolved.keys;
      trackedFailures = resolved.failures;
    } catch (error) {
      // A resolution failure leaves the last good set in place rather than
      // blanking the panel; the next cycle tries again.
      logger.warn(`cannot resolve tracked keys: ${String(error)}`);
    }
  }

  /**
   * Advance every session's log scan, yielding the event loop between slices.
   *
   * Each `scanSessionLog` call resumes at the offset the previous pass left,
   * so a slice boundary is free: nothing is buffered across the yield and an
   * interrupted pass simply continues next time. Only a pass that consumed
   * frames can have moved a number, which is what the caller republishes on.
   * @returns whether any frame was consumed.
   */
  async function scanTrackedLogs() {
    if (trackedScanning) return false;
    trackedScanning = true;
    try {
      const logs = listSessionLogs({ sessionsDir: ledger.sessionsDir });
      const keep = new Set();
      let consumed = 0;
      let sliceStartedAt = Date.now();
      for (const log of logs) {
        keep.add(log.sessionId);
        let state = trackedBySession.get(log.sessionId);
        if (state === undefined) {
          state = createScanState();
          trackedBySession.set(log.sessionId, state);
        }
        consumed += scanSessionLog({ path: log.path, state, keys: trackedKeys });
        if (Date.now() - sliceStartedAt >= TRACKED_SCAN_BUDGET_MS) {
          await new Promise((resolve) => setImmediate(resolve));
          sliceStartedAt = Date.now();
        }
      }
      // A session whose log is gone must not keep contributing its last
      // figures, and its state must not accumulate forever.
      for (const id of [...trackedBySession.keys()]) {
        if (!keep.has(id)) trackedBySession.delete(id);
      }
      trackedScannedAt = Date.now();
      return consumed > 0;
    } finally {
      trackedScanning = false;
    }
  }

  /**
   * Build one wire snapshot per tracked key.
   *
   * One snapshot per key rather than one per machine, because the aggregator
   * stores the newest value per `(instance, fingerprint)`: bundling keys would
   * make a single key's movement overwrite its siblings.
   * @param now - the report time.
   * @param seq - the sequence number for this report.
   * @returns the snapshots, in configured key order.
   */
  function snapshotsOf(now, seq) {
    const uncovered = [...trackedFold.uncovered].sort();
    const snapshots = [];
    for (const entry of trackedFold.entries.values()) {
      // The attributed view, not the log-only one: what this machine reports to
      // a peer has to be what it shows locally, or the headline would drop the
      // moment an aggregator took over.
      const view = attributedView(entry);
      snapshots.push({
        schema: SNAPSHOT_SCHEMA,
        instance: instanceId,
        label: ledger.instanceLabel,
        fingerprint: entry.fingerprint,
        ref: entry.ref ?? null,
        month: period.key,
        totals: attributedTotals(entry),
        days: view.days,
        models: view.models,
        uncovered,
        seq,
        reportedAt: now,
      });
    }
    return snapshots;
  }

  /**
   * Report this machine's figures, and hold them locally when it aggregates.
   *
   * Every failure is a status field, never a throw and never a line of log per
   * attempt: an aggregator that is off for a week must not fill a log file, and
   * the ledger is a convenience that must not take its host down with it.
   * @param now - the report time.
   * @returns whether the local aggregate changed as a result.
   */
  async function reportTracked(now) {
    // Two independent jobs live here, and only one of them needs a destination.
    // Holding this machine's own figures in its own store is gated on
    // *aggregating*; sending them somewhere is gated on *reporting*. Gating
    // both on the report — as this once did — leaves a hub machine with no
    // `aggregatorUrl` (the ordinary way to run one, since a hub has nobody to
    // POST to) with an empty store, and its own panel would then list every
    // machine except itself.
    const mayReport = runs.reporter && ledger.ingestUrl !== undefined;
    if (aggregateStore === undefined && !mayReport) return false;
    const snapshots = snapshotsOf(now, reportSeq + 1);
    if (snapshots.length === 0) {
      // Nothing tracked means nothing to hold and nothing to send; claiming
      // "ok" would report a delivery that never happened.
      if (mayReport) reporterStatus = { state: 'idle', url: ledger.ingestUrl };
      return false;
    }
    reportSeq += 1;
    let changed = false;
    if (aggregateStore !== undefined) {
      // An aggregator that also reports must hold its own figures: a store fed
      // only by peers would show the panel every machine but this one. The
      // local snapshot goes through the same normalization as a wire report so
      // the store holds one shape, whichever path put it there — a raw insert
      // here would be missing the fields the wire path derives (the short
      // fingerprint among them) and the panel would show a key with no name.
      for (const snapshot of snapshots) {
        const normalized = normalizeSnapshot(snapshot);
        if (!normalized.ok) {
          logger.warn(`local snapshot rejected by its own normalizer: ${normalized.reason}`);
          continue;
        }
        if (aggregateStore.merge(normalized.snapshot).changed) changed = true;
      }
    }
    if (!mayReport) return changed;
    if (typeof fetch !== 'function') {
      reporterStatus = { state: 'unsupported', url: ledger.ingestUrl };
      return changed;
    }
    let failure;
    for (const snapshot of snapshots) {
      try {
        const response = await fetch(ledger.ingestUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${ledger.collectorToken}`,
          },
          body: JSON.stringify(snapshot),
          signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(REPORT_TIMEOUT_MS) : undefined,
        });
        if (!response.ok) failure = `HTTP ${String(response.status)}`;
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      // One refused snapshot means the aggregator is not accepting reports, so
      // the rest of the round would only repeat the failure.
      if (failure !== undefined) break;
    }
    const state = failure === undefined ? 'ok' : 'error';
    if (state !== reporterStatus.state) {
      if (state === 'ok') logger.info(`reporting to ${ledger.ingestUrl}`);
      else logger.warn(`report to ${ledger.ingestUrl} failed: ${failure}`);
    }
    reporterStatus = failure === undefined
      ? { state, url: ledger.ingestUrl, lastAt: now }
      : { state, url: ledger.ingestUrl, message: failure };
    return changed;
  }

  /**
   * One third-party reader's attribution state, in the published shape.
   *
   * All three readers report the same six facts, so they publish through the
   * same assembly rather than three hand-written object literals that would
   * drift apart the first time one of them gained a field.
   * @param attribution - the reader's state.
   * @param provider - the matched provider label, or `null`.
   * @param extra - any reader-specific fields to carry alongside.
   * @returns the published block for one reader.
   */
  function thirdPartyState(attribution, provider, extra = {}) {
    return {
      state: attribution.state,
      provider,
      ...(attribution.state === 'ok' ? { totals: attribution.totals, messages: attribution.messages } : {}),
      ...(attribution.providers === undefined ? {} : { providers: attribution.providers }),
      ...(attribution.message === undefined ? {} : { message: attribution.message }),
      ...(attribution.undated === undefined ? {} : { undated: attribution.undated }),
      ...extra,
    };
  }

  /**
   * The published shape of the cross-machine half.
   * @returns the `tracked` payload section.
   */
  function trackedPayload() {
    const aggregated =
      aggregateStore === undefined
        ? undefined
        : aggregateOf({ store: aggregateStore, now: Date.now(), staleAfterHours: ledger.staleAfterHours, month: period.key });
    const keys = [];
    if (aggregated === undefined) {
      const now = Date.now();
      for (const entry of trackedFold.entries.values()) {
        const view = attributedView(entry);
        keys.push({
          fingerprint: entry.fingerprint,
          short: entry.short,
          ref: entry.ref ?? null,
          providers: entry.providers,
          // Configured here, so this is *my* key. The flag exists because an
          // aggregator's key list also carries keys peers reported, and only
          // this machine's own keys may be added under "my key".
          trackedHere: true,
          month: view.month,
          totals: attributedTotals(entry),
          days: view.days,
          models: view.models,
          instances: [
            {
              instance: instanceId,
              label: ledger.instanceLabel,
              month: period.key,
              seq: reportSeq,
              reportedAt: trackedScannedAt,
              ageMs: trackedScannedAt === 0 ? null : now - trackedScannedAt,
              stale: false,
              total: view.month,
            },
          ],
        });
      }
    } else {
      for (const key of aggregated.keys) {
        const local = trackedFold.entries.get(key.fingerprint);
        keys.push({
          fingerprint: key.fingerprint,
          short: key.short,
          ref: key.ref ?? local?.ref ?? null,
          providers: local?.providers ?? [],
          // A peer can report a key this machine does not track — a colleague
          // pointed at the same aggregator, or a second key on the shared
          // account. Its number is real, but it is not mine, and adding it
          // under "my key" would answer a question nobody asked.
          trackedHere: local !== undefined,
          month: sumBucketMap(key.days),
          totals: key.totals,
          days: key.days,
          models: key.models,
          instances: key.instances,
        });
      }
      for (const entry of trackedFold.entries.values()) {
        if (keys.some((key) => key.fingerprint === entry.fingerprint)) continue;
        const view = attributedView(entry);
        keys.push({
          fingerprint: entry.fingerprint,
          short: entry.short,
          ref: entry.ref ?? null,
          providers: entry.providers,
          trackedHere: true,
          month: view.month,
          totals: attributedTotals(entry),
          days: view.days,
          models: view.models,
          instances: [],
        });
      }
    }
    return {
      keys,
      // When aggregating, the union spans every reporter: a peer's uncovered
      // route is exactly the leak this list exists to expose.
      uncovered: aggregated === undefined ? [...trackedFold.uncovered].sort() : aggregated.uncovered,
      failures: trackedFailures,
      coverage: 'dsh+opencode+pen+workbuddy',
      role: ledger.role,
      // Whether each reader is on *this* key. `state: 'otherKey'` is worth
      // surfacing rather than hiding: it means that tool is running on a
      // different credential and is correctly excluded — a fact, not a gap.
      opencode: thirdPartyState(opencodeAttribution, opencodeMatch?.provider ?? null),
      pen: thirdPartyState(penAttribution, penMatch?.provider ?? null),
      workbuddy: thirdPartyState(workbuddyAttribution, workbuddyMatch === undefined ? null : workbuddyMatch.modelIds.join(', '), {
        modelIds: workbuddyMatch?.modelIds,
      }),
      // `instances` is always present, so a client never has to branch to
      // render the line: a role that does not aggregate sees exactly one
      // instance — itself — which is what its `keys[].instances` already say.
      collector: {
        ...collectorStatus,
        instances: aggregated === undefined ? 1 : aggregated.instances.length,
      },
      reporter: reporterStatus,
    };
  }

  /**
   * The change signature of the published cross-machine shape.
   *
   * Timestamps are deliberately absent, for the same reason `fetchedAt` is
   * excluded from the opencode comparison: they move every cycle, and letting
   * them count as a change would bump the revision — and re-render every open
   * panel — once a minute forever.
   * @returns a string that changes exactly when the published shape does.
   */
  function trackedStateSignature() {
    const parts = [];
    for (const entry of trackedFold.entries.values()) {
      parts.push(`${entry.short}:${String(sumBuckets(attributedTotals(entry)))}:${String(attributedView(entry).month)}`);
    }
    // A third-party share can move while the log fold does not, so each
    // reader's state and figure belong in the signature; a movement here must
    // republish.
    for (const [name, attribution, match] of [
      ['oc', opencodeAttribution, opencodeMatch],
      ['pen', penAttribution, penMatch],
      ['wb', workbuddyAttribution, workbuddyMatch],
    ]) {
      const label = name === 'wb' ? (match?.modelIds.join(',') ?? '') : (match?.provider ?? '');
      parts.push(`${name}:${attribution.state}:${label}:${attribution.state === 'ok' ? String(sumBuckets(attribution.totals)) : ''}`);
    }
    if (aggregateStore !== undefined) {
      const aggregated = aggregateOf({ store: aggregateStore, now: 0, staleAfterHours: ledger.staleAfterHours, month: period.key });
      for (const key of aggregated.keys) parts.push(`agg:${key.short}:${String(key.total)}:${String(key.instances.length)}`);
      parts.push(`aggUn:${aggregated.uncovered.join(',')}`);
    }
    parts.push(`un:${[...trackedFold.uncovered].sort().join(',')}`);
    parts.push(`fail:${trackedFailures.map((failure) => `${failure.ref}/${failure.reason}`).join(',')}`);
    parts.push(`role:${ledger.role}`);
    parts.push(`collector:${collectorStatus.state}:${String(collectorStatus.port ?? '')}:${collectorStatus.message ?? ''}`);
    parts.push(`reporter:${reporterStatus.state}:${reporterStatus.message ?? ''}`);
    return parts.join('|');
  }

  /**
   * One full cycle of the tracked half: resolve, scan, fold, report, publish.
   *
   * Log scanning is skipped entirely when nothing is tracked. That is not only
   * an optimisation: it is what keeps the default configuration byte-identical
   * to the single-machine ledger that existed before this half did, down to
   * not reading a file it has no question about.
   */
  async function refreshTracked() {
    await refreshTrackedKeys();
    if (trackedKeys.length > 0) {
      // Attributed third-party usage is folded into the same day and model
      // buckets the log scan produces, so it has to be current before the fold
      // is read.
      await refreshOpencodeAttribution();
      await refreshPenAttribution();
      await refreshWorkbuddyAttribution();
      await scanTrackedLogs();
    } else {
      opencodeMatch = undefined;
      opencodeAttribution = { state: 'absent' };
      penMatch = undefined;
      penAttribution = { state: 'absent' };
      workbuddyMatch = undefined;
      workbuddyAttribution = { state: 'absent' };
    }
    foldTracked();
    await reportTracked(Date.now());
    const next = trackedStateSignature();
    if (next !== trackedSignature) {
      trackedSignature = next;
      publish();
    }
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
      // The tracked half rides the same cadence: resolve, scan, fold, report.
      void refreshTracked().catch((error) => {
        logger.warn(`tracked refresh failed: ${String(error)}`);
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
        // Every machine-scoped month figure is period-derived, so each one has
        // to be re-read against the new month rather than reused.
        void refreshOpencode();
        void refreshPen();
        void refreshWorkbuddy();
        scheduleMonth();
      }, Math.max(1_000, next.getTime() - now));
      monthTimer.unref?.();
    };
    scheduleMonth();
    // Each third-party tool writes its own record when a call completes and
    // offers nothing to subscribe to, so a poll is the only honest cadence any
    // of them has. They share one schedule rather than three copies of it.
    const stopPollers = [refreshOpencode, refreshPen, refreshWorkbuddy].map((refresh) => {
      let timer;
      const schedule = () => {
        timer = setTimeout(() => {
          void refresh().finally(schedule);
        }, THIRD_PARTY_POLL_MS);
        timer.unref?.();
      };
      void refresh().finally(schedule);
      return () => clearTimeout(timer);
    });
    return () => {
      offChanged();
      clearInterval(heartbeat);
      clearInterval(rescan);
      clearTimeout(monthTimer);
      for (const stop of stopPollers) stop();
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

  ctx.effect(() => {
    if (!runs.aggregator || aggregateStore === undefined) return () => {};
    /**
     * The store the listener writes through.
     *
     * A peer's report lands on an HTTP request, not on this process's scan
     * cadence, so nothing else would notice it: without this repaint an open
     * panel would ignore every teammate's report until the next 60s cycle —
     * and an aggregator whose whole job is to merge peers would look like it
     * was doing nothing.
     */
    const listenerStore = {
      list: () => aggregateStore.list(),
      merge: (snapshot) => {
        const result = aggregateStore.merge(snapshot);
        if (result.changed) publish();
        return result;
      },
    };
    const started = startCollector({
      token: ledger.collectorToken,
      store: listenerStore,
      host: ledger.collectorHost,
      port: ledger.collectorPort,
    });
    if (!started.ok) {
      // No token means no listener at all. The one thing this must never do is
      // start anyway: an aggregator that answers without a token publishes
      // every machine's counts to anything that can reach the port.
      collectorStatus = { state: started.reason };
      return () => {};
    }
    started.server.on('error', (error) => {
      // A port already in use is a configuration fact, not a crash: the
      // reporter half still works and the panel should say so.
      collectorStatus = { state: 'error', host: ledger.collectorHost, port: ledger.collectorPort, message: String(error) };
      publish();
    });
    started.server.listen(ledger.collectorPort, ledger.collectorHost, () => {
      const address = started.server.address();
      const port = address !== null && typeof address === 'object' ? address.port : ledger.collectorPort;
      collectorStatus = { state: 'listening', host: ledger.collectorHost, port };
      logger.info(`collector listening on ${ledger.collectorHost}:${String(port)}`);
      publish();
    });
    return () => {
      try {
        started.server.close();
      } catch {
        // Already closed; nothing left to release.
      }
      aggregateStore.close();
    };
  }, 'token-ledger: collector');

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

  // The tracked half is deliberately *not* awaited by `handle`. It reads
  // session logs, and a panel must never wait on a log scan to see the
  // projection figures that are already available; the tracked keys fill in
  // and republish a moment later.
  void refreshTracked().catch((error) => {
    logger.warn(`initial tracked refresh failed: ${String(error)}`);
  });

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
