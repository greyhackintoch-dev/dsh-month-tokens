/**
 * Per-request attribution: which key, which day, which model.
 *
 * The shipped `tokenUsage` projection cannot answer any of those questions —
 * its state is four buckets and a `(turn, step)` slot, with no identity in it
 * at all. The durable session log can: `request/context` records the provider
 * and model serving the request, and each settled `assistant/message` carries
 * its own `usage` and `time`. So this module reads the log the projection
 * throws away, and it reads it *incrementally* — the log is a sequence of
 * independent zstd frames, so a scan resumes at the first byte it has not
 * consumed rather than decompressing a session's whole history every minute.
 *
 * The fold mirrors the official projection's replacement rule exactly
 * (`@deepseek-ai/dsh-token-meter/lib/types/usage-projection.js`), including
 * the retry slot. Getting that wrong would double-count every retried
 * attempt — a silent, plausible-looking inflation, which is the one failure
 * mode a usage ledger must never have.
 *
 * @module dsh-month-tokens/attribution
 */
import { readSync, openSync, closeSync, readdirSync, statSync } from 'node:fs';
// Imported as a namespace, not as a named binding: `zstdDecompressSync` only
// exists on newer runtimes, and a named import of a missing builtin export is
// a load-time SyntaxError — the whole plugin would fail to boot on a Node that
// this module is supposed to degrade gracefully on.
import zlib from 'node:zlib';
import { join } from 'node:path';
import { matchTrackedKey } from './identity.js';

/** The session-log file names this module understands, newest first. */
export const SESSION_LOG_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd'];

/** The owner used for usage no tracked key claims. */
export const UNATTRIBUTED = 'unattributed';

/** The zstd frame magic (`0x28 0xB5 0x2F 0xFD`), little-endian on the wire. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** The running per-session state a scan carries between passes. */
export function createScanState() {
    return {
        version: 1,
        processedBytes: 0,
        provider: null,
        model: null,
        last: null,
        buckets: Object.create(null),
        uncovered: Object.create(null),
        // Calls this ledger knows happened but cannot weigh. The web-search
        // path issues its own request straight to the provider's
        // Anthropic-compatible endpoint and records `endpoint`, `apiVersion`,
        // and `body` — no usage, no tokens, nothing the fold could add. Measured
        // over the real log set: 424 such events, none carrying a figure. So the
        // honest contribution is a count: it cannot be added to the total, but
        // it can stop the total from being read as complete.
        uncountedWebSearch: 0,
        // A forked session's log opens with a copy of its parent's events.
        // Those settlements were already counted in the parent, so folding them
        // again would charge the same tokens twice. `session/end-seed` marks
        // where the copy ends and this session's own work begins; until it is
        // seen, usage belongs to the parent.
        seedPending: false,
        skippedInherited: 0,
        frames: 0,
    };
}

/** Whether this runtime can decompress the log at all. */
export function zstdAvailable() {
    return typeof zlib.zstdDecompressSync === 'function';
}

/**
 * The absolute offsets of every zstd frame starting at or after `from`.
 *
 * A frame is delimited by the next magic, which is safe here because the
 * frames are written independently and never nested. An empty or truncated
 * tail yields no trailing frame, so a half-written append is simply not
 * consumed yet.
 *
 * @param buffer - bytes read from `from` onward.
 * @param from - the absolute offset `buffer` starts at.
 * @returns `{ start, end }` pairs in absolute offsets; `end` is exclusive.
 */
export function framesIn(buffer, from) {
    const starts = [];
    let index = 0;
    while ((index = buffer.indexOf(FRAME_MAGIC, index)) !== -1) {
        starts.push(index);
        index += FRAME_MAGIC.length;
    }
    return starts.map((start, position) => ({
        start: from + start,
        end: position + 1 < starts.length ? from + starts[position + 1] : from + buffer.length,
    }));
}

/**
 * The token buckets one provider usage sample contributes.
 *
 * Field names follow the provider-reported `usage` the projection folds;
 * a cache field the provider omits is zero, not absent, so every bucket is
 * comparable across machines.
 *
 * @param usage - a provider usage sample.
 * @returns the four-bucket contribution.
 */
export function bucketsFrom(usage) {
    return {
        uncachedInputTokens: numberOrZero(usage.inputTokens),
        outputTokens: numberOrZero(usage.outputTokens),
        cacheReadTokens: numberOrZero(usage.cacheReadTokens),
        cacheWriteTokens: numberOrZero(usage.cacheWriteTokens),
    };
}

/** A finite, non-negative integer, or zero. */
function numberOrZero(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** Whether two bucket sets are identical, as the projection's no-op test. */
export function bucketsEqual(left, right) {
    return left.uncachedInputTokens === right.uncachedInputTokens
        && left.outputTokens === right.outputTokens
        && left.cacheReadTokens === right.cacheReadTokens
        && left.cacheWriteTokens === right.cacheWriteTokens;
}

/** Add `next` into `totals` in place. */
function addInto(totals, next) {
    totals.uncachedInputTokens += next.uncachedInputTokens;
    totals.outputTokens += next.outputTokens;
    totals.cacheReadTokens += next.cacheReadTokens;
    totals.cacheWriteTokens += next.cacheWriteTokens;
}

/** Subtract `previous` from `totals` in place. */
function subtractFrom(totals, previous) {
    totals.uncachedInputTokens -= previous.uncachedInputTokens;
    totals.outputTokens -= previous.outputTokens;
    totals.cacheReadTokens -= previous.cacheReadTokens;
    totals.cacheWriteTokens -= previous.cacheWriteTokens;
}

/** Whether every bucket is zero. */
function isZeroBuckets(buckets) {
    return buckets.uncachedInputTokens === 0
        && buckets.outputTokens === 0
        && buckets.cacheReadTokens === 0
        && buckets.cacheWriteTokens === 0;
}

/**
 * The local calendar day of one event, as `YYYY-MM-DD`.
 *
 * Local, not UTC: the ledger's month boundary is the reader's midnight, so
 * bucketing by `toISOString()` would file the first hours of the 1st under
 * the previous month for anyone east of Greenwich.
 *
 * @param time - the event's `time` in epoch milliseconds.
 * @returns the day key, or `undefined` when the time is unusable.
 */
export function dayKeyOf(time) {
    if (typeof time !== 'number' || !Number.isFinite(time)) {
        return undefined;
    }
    const date = new Date(time);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** Zero-pad to two digits. */
function pad2(value) {
    return value < 10 ? `0${value}` : String(value);
}

/** The bucket map key: owner, day, and model, none of which may contain NUL. */
export function bucketKey(owner, day, model) {
    return `${owner}\u0000${day}\u0000${model}`;
}

/** Split a {@link bucketKey} back into its parts. */
export function parseBucketKey(key) {
    const [owner, day, model] = key.split('\u0000');
    return { owner, day, model };
}

/**
 * The usage one durable settlement reports, mirroring the projection's reader.
 *
 * `assistant/message` carries `usage` directly in every log measured so far.
 * The stream fallback exists because the projection has one, and a settlement
 * that only embedded its usage in the stream would otherwise be counted as
 * zero — the same silent shortfall, one layer down.
 *
 * @param event - an `assistant/message` or `assistant/attempt` event.
 * @returns the usage sample, or `undefined` when the event reports none.
 */
export function usageOf(event) {
    if (event?.type === 'assistant/message' && event.data?.usage !== undefined) {
        return event.data.usage;
    }
    if (event?.type !== 'assistant/message' && event?.type !== 'assistant/attempt') {
        return undefined;
    }
    const stream = event.data?.stream;
    if (!Array.isArray(stream)) {
        return undefined;
    }
    for (let index = stream.length - 1; index >= 0; index -= 1) {
        const chunk = stream[index];
        if (chunk?.type === 'usage' && chunk.usage !== undefined) {
            return chunk.usage;
        }
    }
    return undefined;
}

/**
 * Fold one event into a scan state.
 *
 * @param state - the running state, mutated in place.
 * @param event - one decoded log event.
 * @param keys - resolved tracked keys, from `resolveTrackedKeys`.
 * @returns the state, for chaining.
 */
export function foldEvent(state, event, keys) {
    if (event === null || typeof event !== 'object') {
        return state;
    }
    if (event.type === 'session') {
        // The header frame, read once per session on the pass that starts at
        // offset zero. Only a seeded session has a prefix to skip.
        state.seedPending = event.isSeeded === true;
        return state;
    }
    if (event.type === 'session/end-seed') {
        state.seedPending = false;
        return state;
    }
    if (event.type === 'web/deepseek-search-llm-request') {
        state.uncountedWebSearch += 1;
        return state;
    }
    if (event.type === 'request/context' && event.data !== undefined) {
        state.provider = typeof event.data.provider === 'string' ? event.data.provider : state.provider;
        state.model = typeof event.data.model === 'string' ? event.data.model : state.model;
        return state;
    }
    if (event.type === 'llm/retry-started') {
        // The retried attempt replaces the one before it, so the slot closes
        // and the next sample *adds* rather than replaces.
        const turn = event.data?.turn;
        const step = event.data?.step;
        if (state.last !== null && state.last.turn === turn && state.last.step === step) {
            state.last = null;
        }
        return state;
    }
    const usage = usageOf(event);
    if (usage === undefined) {
        return state;
    }
    if (state.seedPending) {
        // Inherited: already counted under the session this one was forked
        // from. Counted again here only as a diagnostic — never as tokens.
        state.skippedInherited += 1;
        return state;
    }
    const turn = event.data?.turn;
    const step = event.data?.step;
    const day = dayKeyOf(event.time);
    if (day === undefined) {
        // No time means no month, and guessing one would file real tokens
        // under a month they did not happen in. Count it as uncovered instead.
        state.uncovered[`${state.provider ?? 'unknown'} (undated)`] = true;
        return state;
    }
    const model = state.model ?? 'unknown';
    const key = matchTrackedKey(keys, state.provider);
    const owner = key === undefined ? UNATTRIBUTED : key.fingerprint;
    if (key === undefined) {
        state.uncovered[state.provider ?? 'unknown'] = true;
    }
    const next = bucketsFrom(usage);
    const target = bucketKey(owner, day, model);
    const previous = state.last !== null && state.last.turn === turn && state.last.step === step
        ? state.last
        : undefined;
    if (previous !== undefined && bucketsEqual(previous.buckets, next)) {
        return state;
    }
    if (previous !== undefined) {
        // Replacement: undo the sample this slot already contributed, which
        // may sit in a different bucket if the route or model changed.
        const held = state.buckets[previous.key];
        if (held !== undefined) {
            subtractFrom(held, previous.buckets);
            // A bucket a replacement emptied is removed rather than left at
            // zero: the panel lists buckets, and a zero row for a route that
            // contributed nothing is a lie told in the shape of a fact.
            if (isZeroBuckets(held)) {
                delete state.buckets[previous.key];
            }
        }
    }
    let totals = state.buckets[target];
    if (totals === undefined) {
        totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
        state.buckets[target] = totals;
    }
    addInto(totals, next);
    state.last = { turn, step, key: target, buckets: next };
    return state;
}

/**
 * Fold a batch of decoded events.
 *
 * @param state - the running state, mutated in place.
 * @param events - decoded log events, in log order.
 * @param keys - resolved tracked keys.
 * @returns the state.
 */
export function foldEvents(state, events, keys) {
    for (const event of events) {
        foldEvent(state, event, keys);
    }
    return state;
}

/**
 * Decode the JSONL lines one frame carries.
 *
 * A line that does not parse is dropped rather than throwing: a log being
 * appended to is not corrupt just because this read caught a partial line,
 * and the next scan will see the frame again only if it was never consumed.
 *
 * @param text - decompressed frame text.
 * @returns the decoded events.
 */
export function decodeFrame(text) {
    const events = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            continue;
        }
        try {
            events.push(JSON.parse(trimmed));
        } catch {
            // Deliberately dropped; see above.
        }
    }
    return events;
}

/**
 * Advance one session's state over the frames appended since the last scan.
 *
 * Reads only the tail: the file is opened, `processedBytes` is skipped, and
 * whatever follows is consumed frame by frame. A frame that fails to
 * decompress ends the scan *without* advancing past it, so a partially
 * written append is retried next time instead of being lost.
 *
 * @param options - scan inputs.
 * @param options.path - the session log path.
 * @param options.state - the running state, mutated in place.
 * @param options.keys - resolved tracked keys.
 * @returns the number of frames consumed in this pass.
 */
export function scanSessionLog(options) {
    const { path, state, keys } = options;
    if (!zstdAvailable()) {
        return 0;
    }
    let size;
    try {
        size = statSync(path).size;
    } catch {
        return 0;
    }
    if (size <= state.processedBytes) {
        return 0;
    }
    const length = size - state.processedBytes;
    const buffer = Buffer.allocUnsafe(length);
    let fd;
    try {
        fd = openSync(path, 'r');
        let read = 0;
        while (read < length) {
            const got = readSync(fd, buffer, read, length - read, state.processedBytes + read);
            if (got <= 0) {
                break;
            }
            read += got;
        }
        if (read < length) {
            return 0;
        }
    } catch {
        return 0;
    } finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
    let consumed = 0;
    // The base offset is fixed for the whole pass. `state.processedBytes`
    // advances as frames are consumed, and reading it per frame would slide
    // the window under the second frame of a cold pass — silently truncating
    // every session's history to its first frame.
    const base = state.processedBytes;
    for (const frame of framesIn(buffer, base)) {
        let text;
        try {
            text = zlib.zstdDecompressSync(buffer.subarray(frame.start - base, frame.end - base)).toString('utf8');
        } catch {
            // Keep the offset at this frame so the next pass retries it.
            break;
        }
        // Completeness is proven by the trailing newline, because a frame the
        // writer has not finished appending does NOT throw: zstdDecompressSync
        // returns empty or half-line text and reports success (measured on
        // Node 22.22). Advancing past such a frame would drop its events
        // permanently and silently, so the offset only moves for text that
        // ends where every appended batch ends. Measured over 7281 real frames
        // from 20 session logs: none empty, none missing the newline.
        if (!text.endsWith('\n')) {
            break;
        }
        foldEvents(state, decodeFrame(text), keys);
        state.processedBytes = frame.end;
        consumed += 1;
    }
    state.frames += consumed;
    return consumed;
}

/**
 * Every session log under a DSH home, with its size.
 *
 * Layout is `<sessions>/<encoded workspace>/<sessionId>/<log name>`. A
 * workspace directory that cannot be read is skipped: one unreadable
 * directory must not blind the ledger to every other session.
 *
 * @param options - discovery inputs.
 * @param options.sessionsDir - the DSH home's `sessions` directory.
 * @returns one record per session log found.
 */
export function listSessionLogs(options) {
    const { sessionsDir } = options;
    const found = [];
    let workspaces;
    try {
        workspaces = readdirSync(sessionsDir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const workspace of workspaces) {
        if (!workspace.isDirectory()) {
            continue;
        }
        const workspaceDir = join(sessionsDir, workspace.name);
        let sessions;
        try {
            sessions = readdirSync(workspaceDir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const session of sessions) {
            if (!session.isDirectory()) {
                continue;
            }
            const sessionDir = join(workspaceDir, session.name);
            for (const name of SESSION_LOG_NAMES) {
                const path = join(sessionDir, name);
                try {
                    const stats = statSync(path);
                    if (stats.isFile()) {
                        found.push({ sessionId: session.name, workspace: workspace.name, path, size: stats.size });
                        break;
                    }
                } catch {
                    // Try the next accepted name.
                }
            }
        }
    }
    return found;
}
