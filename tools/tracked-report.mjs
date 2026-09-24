#!/usr/bin/env node
/**
 * Print one key's calendar month, straight from local data, with DSH stopped.
 *
 * This is a diagnostic tool, not the plugin: it exists so the number can be
 * checked — and the wiring trusted — without booting a profile, restarting
 * `dsh web`, or waiting for a scan. What it prints is a short fingerprint and
 * counts. It never prints, logs, or writes the key, and the only thing it
 * does with the key is hash it (see `lib/identity.js`).
 *
 * Usage:
 *   node tools/tracked-report.mjs [--ref NAME] [--providers a,b] \
 *        [--pattern REGEX] [--month YYYY-MM] [--sessions DIR] [--json]
 *
 * Anything not passed is defaulted from the measured routes: four distinct
 * route families were observed spending this key — `deepseek-official`,
 * `vision-toolkit-deepseek-official`, `vision-toolkit-deepseek-official-vision`,
 * `modlens-deepseek` — so the default is deliberately broad (`deepseek`
 * anywhere in the id) rather than a whitelist that silently misses the next
 * plugin to register one. The breadth is safe because the bucket is settled by
 * the key fingerprint, not the route name; and it is *visible*, because
 * whatever the log contains that no target claims is printed as `uncovered`.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseOpencodeAuthKeys, resolveTrackedKeys, parseWorkbuddyModelKeys } from '../lib/identity.js';
import { createScanState, listSessionLogs, parseBucketKey, scanSessionLog } from '../lib/attribution.js';

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

/** Parse `--flag value` pairs. */
function parseArgs(argv) {
    const args = { providers: [], patterns: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const next = argv[index + 1];
        if (token === '--json') {
            args.json = true;
            continue;
        }
        if (!token.startsWith('--') || next === undefined) {
            continue;
        }
        index += 1;
        if (token === '--ref') args.ref = next;
        else if (token === '--providers') args.providers.push(...next.split(',').map(entry => entry.trim()).filter(Boolean));
        else if (token === '--pattern') args.patterns.push(next);
        else if (token === '--month') args.month = next;
        else if (token === '--sessions') args.sessions = next;
    }
    return args;
}

/**
 * Read one credential straight out of the local store.
 *
 * Deliberately minimal: this tool has no dependency and the store is a small
 * YAML document, so both the block and the flow spelling of `refs` are
 * handled. The value is returned to the caller and never rendered.
 *
 * @param text - the store's contents.
 * @param ref - the reference name to look up.
 * @returns the value, or `undefined`.
 */
export function credentialFromStore(text, ref) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const flow = new RegExp(`refs:\\s*\\{([^}]*)\\}`, 'u').exec(text);
    if (flow !== null) {
        const pair = new RegExp(`(?:^|,)\\s*${escaped}\\s*:\\s*([^,}\\s]+)`, 'u').exec(flow[1]);
        if (pair !== null) return pair[1];
    }
    const block = new RegExp(`^\\s*${escaped}\\s*:\\s*(\\S+)\\s*$`, 'mu').exec(text);
    return block === null ? undefined : block[1];
}

/** Sum a bucket set. */
const totalOf = buckets => BUCKETS.reduce((sum, field) => sum + buckets[field], 0);

/** A grouped, readable count. */
const group = value => value.toLocaleString('en-US');

export async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const month = args.month ?? new Date().toISOString().slice(0, 7);
    const ref = args.ref ?? 'DEEPSEEK_API_KEY';
    const providers = args.providers.length > 0 ? args.providers : ['deepseek-official'];
    const patterns = args.patterns.length > 0 ? args.patterns : ['deepseek'];

    // The key is looked for in the environment first (the documented fallback the
    // provider adapters use), then in the local store.
    let key = process.env[ref];
    let source = 'env';
    if (key === undefined) {
        try {
            key = credentialFromStore(readFileSync(join(DSH_HOME, '.credentials.yaml'), 'utf8'), ref);
            source = 'store';
        } catch {
            source = 'absent';
        }
    }

    const resolved = await resolveTrackedKeys({
        trackKeys: [{ ref, providers, providerPatterns: patterns }],
        // The credential service only exists inside a running DSH; this tool is
        // the outside-the-process path, so it passes the value through the same
        // fingerprinting the service would feed.
        credentials: key === undefined ? undefined : { async resolve() { return { value: key, source }; } },
        env: {},
    });

    if (resolved.keys.length === 0) {
        console.error(`Could not fingerprint ${ref}: ${JSON.stringify(resolved.failures)}`);
        process.exitCode = 1;
    } else {
        const tracked = resolved.keys[0];
        const sessionsDir = args.sessions ?? join(DSH_HOME, 'sessions');
        const logs = listSessionLogs({ sessionsDir });
        const perDay = new Map();
        const perModel = new Map();
        const uncovered = new Set();
        let total = 0;
        let frames = 0;
        let uncountedWebSearch = 0;
        const started = Date.now();

        for (const log of logs) {
            const state = createScanState();
            frames += scanSessionLog({ path: log.path, state, keys: resolved.keys });
            uncountedWebSearch += state.uncountedWebSearch;
            for (const [bucketKeyName, buckets] of Object.entries(state.buckets)) {
                const { owner, day, model } = parseBucketKey(bucketKeyName);
                if (!day.startsWith(month)) continue;
                const tokens = totalOf(buckets);
                if (owner === tracked.fingerprint) {
                    total += tokens;
                    perDay.set(day, (perDay.get(day) ?? 0) + tokens);
                    perModel.set(model, (perModel.get(model) ?? 0) + tokens);
                }
            }
            // `state.uncovered` is a name→flag map: a route nobody claims is worth
            // naming, and its amount is by definition not part of the total above.
            for (const provider of Object.keys(state.uncovered)) {
                uncovered.add(provider);
            }
        }

        // The three third-party clients store the real key, so whether their
        // traffic is *this* key's is decided by fingerprinting it — never by
        // trusting a provider or model name.
        /**
         * Fingerprint one client's credential store through its own parser.
         * @param read - returns the decoded store.
         * @param parse - the parser for that store's shape.
         * @param label - how a matched entry is named in the report.
         * @returns the client's credential state.
         */
        const credentialState = (read, parse, label) => {
            try {
                const verdicts = parse(read());
                const mine = verdicts.filter(entry => entry.ok && entry.fingerprint === tracked.fingerprint);
                return { state: 'ok', providers: verdicts.map(entry => entry.provider), mine: mine.map(label) };
            } catch (error) {
                return { state: 'unreadable', message: String(error?.code ?? error?.message ?? error) };
            }
        };
        const opencode = credentialState(
            () => JSON.parse(readFileSync(join(homedir(), '.local', 'share', 'opencode', 'auth.json'), 'utf8')),
            parseOpencodeAuthKeys,
            entry => entry.provider,
        );
        const pen = credentialState(
            () => JSON.parse(readFileSync(join(homedir(), '.pencil', 'agent-auth'), 'utf8')),
            // The same shape as opencode's, so the same parser.
            parseOpencodeAuthKeys,
            entry => entry.provider,
        );
        const workbuddy = credentialState(
            () => JSON.parse(readFileSync(join(homedir(), '.workbuddy', 'models.json'), 'utf8')),
            parseWorkbuddyModelKeys,
            entry => entry.modelId,
        );

        if (args.json) {
            console.log(JSON.stringify({
                ref: tracked.ref,
                short: tracked.short,
                source: tracked.source,
                month,
                total,
                perDay: Object.fromEntries([...perDay].sort()),
                perModel: Object.fromEntries([...perModel].sort((left, right) => right[1] - left[1])),
                uncovered: [...uncovered].sort(),
                opencode,
                pen,
                workbuddy,
                scan: { sessions: logs.length, frames, ms: Date.now() - started },
                uncountedWebSearch,
            }, null, 2));
        } else {
            console.log(`ref            ${tracked.ref}  (resolved from ${tracked.source})`);
            console.log(`fingerprint    ${tracked.short}…      ${tracked.fingerprint.length}-hex, key never printed`);
            console.log(`month          ${month}`);
            console.log(`TOTAL          ${group(total)}`);
            console.log(`\nper day`);
            for (const [day, tokens] of [...perDay].sort()) console.log(`  ${day}  ${group(tokens).padStart(14)}`);
            console.log(`\nper model`);
            for (const [model, tokens] of [...perModel].sort((left, right) => right[1] - left[1])) console.log(`  ${model.padEnd(32)} ${group(tokens).padStart(14)}`);
            const uncoveredNames = [...uncovered].sort();
            console.log(`\nuncovered routes seen in the log (NOT counted above)`);
            console.log(uncoveredNames.length === 0 ? '  (none)' : uncoveredNames.map(name => `  ${name}`).join('\n'));
            const describe = (state) => (state.state === 'ok'
                ? `stores keys for [${state.providers.join(', ')}]; on THIS key: ${state.mine.length === 0 ? 'no' : state.mine.join(', ')}`
                : state.state);
            console.log(`\nopencode       ${describe(opencode)}`);
            console.log(`pen            ${describe(pen)}`);
            console.log(`workbuddy      ${describe(workbuddy)}`);
            console.log(`\nscan           ${logs.length} session logs, ${frames} frames, ${Date.now() - started}ms`);
            console.log(`uncounted      ${uncountedWebSearch} web-search LLM call(s) in these logs, whose tokens`);
            console.log(`               the provider reports nowhere in the session — NOT included above`);
            console.log(`coverage       DSH session logs only. opencode / Pen / WorkBuddy token sums are added by`);
            console.log(`               the plugin route; anything that keeps no local record is invisible, so this`);
            console.log(`               is a floor, not a total.`);
        }
    }
}

// Only run when invoked directly: the store reader below is imported by the
// test suite, which must not trigger a full scan as a side effect.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
