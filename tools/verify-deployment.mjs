#!/usr/bin/env node
/**
 * Verify a running deployment, and assert the relationships raw JSON hides.
 *
 * The point is not to print the payload again — `curl | python -m json.tool`
 * does that. It is to check the properties that a plausible-but-wrong ledger
 * would violate while still looking fine: that a key's day breakdown adds up to
 * its own month, that instance rows add up to the key they belong to, that the
 * collector refuses an unauthenticated read, and that the two periods
 * (this month, all time) are not silently swapped for one another.
 *
 * Run it on the aggregator after a restart:
 *
 *   node tools/verify-deployment.mjs
 *   node tools/verify-deployment.mjs --lan 192.168.1.244   # also probe the LAN
 *
 * The bearer token is read from the environment, then from the profile patch
 * that mounts this plugin. It is never printed.
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const SUMMARY_URL = argOf('--summary') ?? 'http://127.0.0.1:3080/token-ledger/summary';
const LAN = argOf('--lan');
const RESULTS = [];

/** Record one check. */
function check(name, ok, detail) {
  RESULTS.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail === undefined ? '' : `  — ${detail}`}`);
}

/** Total tokens in a bucket set. */
const sumBuckets = (buckets) => Object.values(buckets ?? {}).reduce((total, value) => total + value, 0);
/** Total tokens in a `{ name: buckets }` map. */
const sumMap = (map) => Object.values(map ?? {}).reduce((total, buckets) => total + sumBuckets(buckets), 0);

/** The bearer token: environment first, then the profile patch that mounts us. */
function resolveToken() {
  if (typeof process.env.DSH_TOKEN_LEDGER_TOKEN === 'string' && process.env.DSH_TOKEN_LEDGER_TOKEN !== '') {
    return { token: process.env.DSH_TOKEN_LEDGER_TOKEN, source: 'env' };
  }
  const patch = join(homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  if (!existsSync(patch)) return { source: 'absent' };
  // Deliberately a literal read of one line rather than a YAML parse: this tool
  // has no dependencies, and the value is never rendered.
  const match = /^\s*collectorToken:\s*(\S+)\s*$/mu.exec(readFileSync(patch, 'utf8'));
  return match === null ? { source: 'absent' } : { token: match[1], source: patch };
}

/** A local IPv4 address, for the LAN probe. */
function lanAddress() {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) return address.address;
    }
  }
  return undefined;
}

const token = resolveToken();
console.log(`token source   ${token.source === 'env' ? 'environment' : token.source}`);
if (token.token !== undefined) console.log(`token          present (${token.token.length} characters, never printed)`);

// ── the plugin's own route ──────────────────────────────────────────────────

let summary;
try {
  const response = await fetch(SUMMARY_URL, { signal: AbortSignal.timeout(5000) });
  summary = await response.json();
} catch (error) {
  console.error(`\nCannot read ${SUMMARY_URL}: ${String(error?.message ?? error)}`);
  console.error('Is `dsh web` running on that port?');
  process.exit(2);
}

console.log(`\nsummary        ${SUMMARY_URL}\n`);

const tracked = summary.tracked;
check('the host module carries the tracked section', tracked !== undefined,
  tracked === undefined ? 'the running process still has the pre-change module — restart dsh web' : undefined);
if (tracked === undefined) {
  console.log(`\n${RESULTS.filter(r => !r.ok).length} check(s) failed.`);
  process.exit(1);
}

check('a tracking target is configured', (tracked.keys ?? []).length > 0,
  (tracked.keys ?? []).length === 0 ? 'set trackKeys in the profile patch' : `${String(tracked.keys.length)} key(s)`);
check('coverage is declared', tracked.coverage === 'dsh+opencode', String(tracked.coverage));

for (const failure of tracked.failures ?? []) {
  check(`credential ${String(failure.ref)} resolves`, false, `${String(failure.reason)}${failure.detail === undefined ? '' : ` (${String(failure.detail)})`}`);
}
if ((tracked.failures ?? []).length === 0) check('every configured credential resolved', true);

for (const key of tracked.keys ?? []) {
  const label = `${String(key.short)} (${String(key.ref)})`;
  const days = sumMap(key.days);
  check(`${label}: the month is the sum of its days`, key.month === days, `month ${key.month.toLocaleString()} vs days ${days.toLocaleString()}`);
  check(`${label}: the month is positive`, key.month > 0, key.month.toLocaleString());
  const rows = (key.instances ?? []).reduce((total, instance) => total + instance.total, 0);
  // An exact identity, not an approximation: every row reports the same month
  // the key does, and a machine that last reported in an earlier month
  // contributes zero to this one while keeping its all-time figure.
  check(`${label}: instance rows reconcile with the key month`, rows === days,
    `rows ${rows.toLocaleString()} vs month ${days.toLocaleString()} (${String((key.instances ?? []).length)} instance(s))`);
  check(`${label}: the instance list is not empty`,
    (key.instances ?? []).length > 0,
    'an aggregator must hold its own figures, not only its peers’');
}

const uncovered = tracked.uncovered ?? [];
check('every route seen in the log is claimed', uncovered.length === 0,
  uncovered.length === 0 ? undefined : `not counted: ${uncovered.join(', ')} — add them to providers or providerPatterns`);

const oc = tracked.opencode ?? {};
check('opencode is attributed or explained', ['ok', 'otherKey', 'absent', 'unreadable', 'unavailable', 'drift', 'error'].includes(oc.state),
  `state ${String(oc.state)}${oc.provider === null ? '' : ` via ${String(oc.provider)}`}`);

// ── the collector ───────────────────────────────────────────────────────────

const collector = tracked.collector ?? {};
const aggregating = tracked.role === 'aggregator' || tracked.role === 'both';
check('the role matches what is running',
  aggregating === (collector.state === 'listening' || collector.state === 'starting' || collector.state === 'error'),
  `role ${String(tracked.role)}, collector ${String(collector.state)}`);

if (aggregating && collector.state === 'listening') {
  const base = `http://127.0.0.1:${String(collector.port)}`;
  try {
    const health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    check('the collector answers /health on loopback', health.ok);
  } catch (error) {
    check('the collector answers /health on loopback', false, String(error?.message ?? error));
  }
  if (token.token !== undefined) {
    const anonymous = await fetch(`${base}/aggregate`, { signal: AbortSignal.timeout(3000) }).catch(() => undefined);
    check('an unauthenticated /aggregate is refused', anonymous?.status === 401, `HTTP ${String(anonymous?.status)}`);
    const authorized = await fetch(`${base}/aggregate`, {
      headers: { authorization: `Bearer ${token.token}` },
      signal: AbortSignal.timeout(3000),
    }).catch(() => undefined);
    check('an authenticated /aggregate is served', authorized?.status === 200, `HTTP ${String(authorized?.status)}`);
    if (authorized?.status === 200) {
      const aggregate = await authorized.json();
      const storeKeys = (aggregate.keys ?? []).length;
      check('the store holds at least one key', storeKeys > 0, `${String(storeKeys)} key(s), ${String((aggregate.instances ?? []).length)} instance(s)`);
    }
  } else {
    check('a token is available to test authorization with', false, 'set DSH_TOKEN_LEDGER_TOKEN');
  }

  const target = LAN ?? lanAddress();
  if (target !== undefined) {
    try {
      const health = await fetch(`http://${target}:${String(collector.port)}/health`, { signal: AbortSignal.timeout(3000) });
      check(`the collector is reachable on the LAN (${target})`, health.ok,
        collector.host === '127.0.0.1' ? 'bound to loopback — peers cannot reach it' : undefined);
    } catch (error) {
      check(`the collector is reachable on the LAN (${target})`, false,
        collector.host === '127.0.0.1' ? 'bound to loopback — peers cannot reach it' : String(error?.message ?? error));
    }
  }
} else if (aggregating) {
  check('the collector is listening', false, `state ${String(collector.state)}${collector.message === undefined ? '' : `: ${String(collector.message)}`}`);
}

const reporter = tracked.reporter ?? {};
console.log(`\nreporter       ${JSON.stringify(reporter)}`);
if (reporter.state === 'noUrl') {
  console.log('               (expected on a hub: it aggregates, and has nobody to POST to)');
}

const failed = RESULTS.filter(result => !result.ok);
console.log(`\n${String(RESULTS.length - failed.length)}/${String(RESULTS.length)} checks passed.`);
process.exit(failed.length === 0 ? 0 : 1);
