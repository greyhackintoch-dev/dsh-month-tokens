/**
 * Credential identity: the fingerprint that makes "the same API key" one
 * bucket across machines.
 *
 * The ledger's unit of account is a *key*, not a machine. The same key used
 * from the web GUI, the desktop shell, and a second laptop must sum into one
 * number, and the only join key available is derived from the key itself — so
 * everything here is built around one rule: **the key never leaves this
 * process, and only its hash ever leaves the machine.**
 *
 * Why not reuse `deepSeekFileScope` (`sha256(baseURL + "\0" + apiKey)`,
 * `@deepseek-ai/dsh-llm-deepseek`)? Because that scope answers a different
 * question. File scopes must separate endpoints — the same key against a
 * proxy and against the origin are different file namespaces. Here the
 * opposite is required: the same key reached through a different base URL on
 * another machine is *the same key* and must collide. Hence the key alone,
 * under a domain separator of this plugin's own.
 *
 * @module dsh-month-tokens/identity
 */
import { createHash } from 'node:crypto';

/**
 * Domain separator for the fingerprint. Versioned so a future change to the
 * derivation cannot silently re-bucket history.
 */
export const FINGERPRINT_DOMAIN = 'dsh-month-tokens/key/v1';

/**
 * Characters an HTTP header carries and every known provider key uses:
 * printable ASCII, space excluded. Mirrors the transport invariant in
 * `@deepseek-ai/dsh-llm/api-key` — a key outside this set cannot reach a
 * provider, so admitting it here would only produce a bucket nothing can
 * ever be attributed to.
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;

/**
 * Judge one supplied key, trimming surrounding whitespace first.
 *
 * Trimming is silent because a padded key has one unambiguous reading; every
 * other defect is reported. This returns a verdict rather than throwing
 * because the caller's job is to *report* an unusable credential — a key the
 * ledger cannot fingerprint must surface as "not tracked", never as a zero
 * that quietly disappears into the total.
 *
 * @param raw - the key exactly as resolved from the credential store.
 * @returns the normalized key, or why it cannot be fingerprinted.
 */
export function normalizeApiKey(raw) {
    if (typeof raw !== 'string') {
        return { ok: false, reason: 'absent' };
    }
    const value = raw.trim();
    if (value.length === 0) {
        return { ok: false, reason: 'empty' };
    }
    if (!LEGAL_API_KEY.test(value)) {
        return { ok: false, reason: 'illegalCharacters' };
    }
    return { ok: true, value };
}

/**
 * The fingerprint of one key: the cross-machine bucket id.
 *
 * @param raw - the key exactly as resolved from the credential store.
 * @returns the hex fingerprint, or why it cannot be computed.
 */
export function fingerprintOfKey(raw) {
    const normalized = normalizeApiKey(raw);
    if (!normalized.ok) {
        return normalized;
    }
    return {
        ok: true,
        fingerprint: createHash('sha256')
            .update(FINGERPRINT_DOMAIN)
            .update('\0')
            .update(normalized.value)
            .digest('hex'),
    };
}

/**
 * The display form of a fingerprint.
 *
 * Only this prefix may reach a log line, a payload, or the panel: it is
 * enough to tell two keys apart and to eyeball that two machines agreed, and
 * short enough that publishing it does not publish a usable identifier of
 * the key.
 *
 * @param fingerprint - a full fingerprint.
 * @returns its first 8 hex characters, or an empty string for a non-string.
 */
export function shortFingerprint(fingerprint) {
    return typeof fingerprint === 'string' ? fingerprint.slice(0, 8) : '';
}

/**
 * Normalize the `trackKeys` config into resolved tracking targets.
 *
 * Accepts bare refs (`['DEEPSEEK_API_KEY']`), single-provider records
 * (`[{ ref, provider }]`), and the multi-provider form the log actually
 * demands (`[{ ref, providers: [...], providerPatterns: [...] }]`).
 *
 * The multi-provider form is not a convenience. Provider routes are an open
 * set — the shipped adapter registers `deepseek-official`, and any plugin can
 * register more (`vision-toolkit-deepseek-official`, measured) that resolve
 * the very same credential. Matching on one name would silently under-count
 * exactly the calls the user is trying to see, so a target names every route
 * it owns, with patterns as the escape hatch for routes discovered later.
 *
 * @param raw - the configured value, of any accepted shape.
 * @returns one target per distinct ref, in config order.
 */
export function normalizeTrackKeys(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set();
    const targets = [];
    for (const entry of raw) {
        const candidate = typeof entry === 'string' ? { ref: entry } : entry;
        if (candidate === null || typeof candidate !== 'object') {
            continue;
        }
        const ref = typeof candidate.ref === 'string' ? candidate.ref.trim() : '';
        if (ref.length === 0 || seen.has(ref)) {
            continue;
        }
        seen.add(ref);
        const providers = providerListOf(candidate, ref);
        targets.push({
            ref,
            provider: providers[0],
            providers,
            providerPatterns: stringListOf(candidate.providerPatterns),
        });
    }
    return targets;
}

/**
 * Every provider route a target claims, in declaration order.
 *
 * `provider` (singular) is accepted for a single-route key and folded into
 * the same list; a target that names no route at all falls back to the name
 * derived from its ref.
 */
function providerListOf(candidate, ref) {
    const list = [];
    if (Array.isArray(candidate.providers)) {
        for (const provider of candidate.providers) {
            if (typeof provider === 'string' && provider.trim().length > 0) {
                list.push(provider.trim());
            }
        }
    }
    if (typeof candidate.provider === 'string' && candidate.provider.trim().length > 0) {
        list.push(candidate.provider.trim());
    }
    if (list.length === 0) {
        list.push(providerFromRef(ref));
    }
    return [...new Set(list)];
}

/** The string members of a config list, dropping everything else. */
function stringListOf(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter(entry => typeof entry === 'string' && entry.trim().length > 0).map(entry => entry.trim());
}

/**
 * Derive a provider id from a credential ref name.
 *
 * `DEEPSEEK_API_KEY` → `deepseek`. Only a fallback for the bare-ref config
 * shape: the provider id must match what `request/context` events record,
 * and a ref that does not follow the convention should be configured
 * explicitly rather than guessed at.
 *
 * @param ref - a credential reference name.
 * @returns the derived provider id, or the lowercased ref when no convention applies.
 */
export function providerFromRef(ref) {
    const stripped = ref
        .replace(/^DSH_/u, '')
        .replace(/_(API_)?KEY$/u, '')
        .replace(/_API$/u, '');
    return (stripped.length > 0 ? stripped : ref).toLowerCase().replace(/_/gu, '-');
}

/**
 * Resolve every tracked key to a fingerprint.
 *
 * Resolution order mirrors the provider adapters: the credentials service
 * owns stored values, and the launching environment is the documented
 * fallback when no such service is mounted. A ref that resolves to nothing is
 * reported as a failure rather than skipped, because "configured but
 * unresolvable" and "not configured" mean very different things to someone
 * reading the panel.
 *
 * @param options - resolution inputs.
 * @param options.credentials - the credential service, when mounted.
 * @param options.trackKeys - the raw `trackKeys` config.
 * @param options.env - environment to fall back to; defaults to `process.env`.
 * @returns the resolved fingerprints plus one failure per unresolvable ref.
 */
export async function resolveTrackedKeys(options) {
    const { credentials, trackKeys, env = process.env } = options;
    const resolved = [];
    const failures = [];
    for (const target of normalizeTrackKeys(trackKeys)) {
        // A pattern that does not compile is reported and dropped: the routes
        // named explicitly still attribute, and a typo in an escape hatch
        // shows up as a failure line instead of quietly shrinking the month.
        const patterns = [];
        for (const source of target.providerPatterns) {
            try {
                patterns.push(new RegExp(source));
            } catch {
                failures.push({ ref: target.ref, provider: target.provider, reason: 'invalidPattern', detail: source });
            }
        }
        let value;
        let source;
        if (credentials !== undefined) {
            try {
                const hit = await credentials.resolve(target.ref);
                if (hit !== undefined) {
                    value = hit.value;
                    source = hit.source;
                }
            } catch (error) {
                failures.push({ ref: target.ref, provider: target.provider, reason: 'resolveFailed', detail: messageOf(error) });
                continue;
            }
        }
        if (value === undefined && env !== undefined && typeof env[target.ref] === 'string') {
            value = env[target.ref];
            source = 'env';
        }
        if (value === undefined) {
            failures.push({ ref: target.ref, provider: target.provider, reason: 'missing' });
            continue;
        }
        const fingerprint = fingerprintOfKey(value);
        if (!fingerprint.ok) {
            failures.push({ ref: target.ref, provider: target.provider, reason: fingerprint.reason });
            continue;
        }
        resolved.push({
            ref: target.ref,
            provider: target.provider,
            providers: target.providers,
            patterns,
            fingerprint: fingerprint.fingerprint,
            short: shortFingerprint(fingerprint.fingerprint),
            source: source ?? 'unknown',
        });
    }
    return { keys: resolved, failures };
}

/**
 * The tracked key that owns one provider route, if any.
 *
 * Explicit route names are consulted before patterns, and the first target in
 * config order wins a tie: with the routes of a key listed explicitly, a
 * pattern is only ever reached by a route the config has not learned yet.
 *
 * @param keys - resolved keys from {@link resolveTrackedKeys}.
 * @param provider - the provider id recorded by a `request/context` event.
 * @returns the owning key, or `undefined` when nothing tracks that route.
 */
export function matchTrackedKey(keys, provider) {
    if (typeof provider !== 'string' || provider.length === 0) {
        return undefined;
    }
    for (const key of keys) {
        if (key.providers.includes(provider)) {
            return key;
        }
    }
    for (const key of keys) {
        for (const pattern of key.patterns) {
            if (pattern.test(provider)) {
                return key;
            }
        }
    }
    return undefined;
}

/** Render an unknown thrown value without letting hostile coercion escape. */
function messageOf(error) {
    try {
        return error instanceof Error ? error.message : String(error);
    } catch {
        return 'unprintable error';
    }
}

/**
 * The fingerprints of the keys opencode has stored.
 *
 * opencode keeps the *real* key per provider in `auth.json` (measured: a
 * `deepseek` entry whose `key` is shaped like a provider key), unlike DSH,
 * which stores a reference and resolves it through the credential service.
 * Fingerprinting that value is the only way to answer the question this
 * ledger actually asks — "is opencode's DeepSeek traffic *my* key's traffic,
 * or a colleague's?" — and it is safe to do because what comes back is a
 * hash. The key is read, hashed, and dropped; it is never returned, logged,
 * or put in a payload.
 *
 * Entries without a `key` are skipped rather than reported: an OAuth provider
 * (`refresh`/`access`/`expires`) simply has no key to fingerprint, which is a
 * different fact from a key that could not be used.
 *
 * @param parsed - the decoded `auth.json`.
 * @returns one verdict per provider that stores a key.
 */
export function parseOpencodeAuthKeys(parsed) {
    const found = [];
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return found;
    }
    for (const [provider, entry] of Object.entries(parsed)) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
            continue;
        }
        if (typeof entry.key !== 'string') {
            continue;
        }
        const fingerprint = fingerprintOfKey(entry.key);
        if (!fingerprint.ok) {
            found.push({ provider, ok: false, reason: fingerprint.reason });
            continue;
        }
        found.push({
            provider,
            ok: true,
            fingerprint: fingerprint.fingerprint,
            short: shortFingerprint(fingerprint.fingerprint),
        });
    }
    return found;
}

/**
 * Whether one opencode provider's stored key is a tracked key.
 *
 * @param options - match inputs.
 * @param options.opencodeKeys - verdicts from {@link parseOpencodeAuthKeys}.
 * @param options.keys - resolved tracked keys.
 * @returns the matched provider and key, or `undefined` when opencode is on a different key.
 */
export function matchOpencodeKey(options) {
    const { opencodeKeys, keys } = options;
    for (const entry of opencodeKeys) {
        if (!entry.ok) {
            continue;
        }
        const key = keys.find(candidate => candidate.fingerprint === entry.fingerprint);
        if (key !== undefined) {
            return { provider: entry.provider, key };
        }
    }
    return undefined;
}
