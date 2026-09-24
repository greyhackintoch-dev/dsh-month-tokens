# dsh-month-tokens

A DeepSeek Harness plugin that puts **one calendar month of token usage for one
API key** in the sidebar, directly above Settings. It counts this DSH home,
opencode, Pen, and WorkBuddy, reads only local data, and resets at 00:00 on the
1st.

Configure `trackKeys` and the number stops being *a machine's* number and
becomes *a key's* number: the same credential used from this laptop, the desktop
shell, and a second machine sums into one figure — joined by a fingerprint of
the key, so the key itself never leaves any of them.

**Coverage is stated, never implied.** The test is *does this caller leave a real
usage record on this machine*, not *is this caller DSH*. Participating DSH homes,
opencode, Pen and WorkBuddy qualify and are read; the same key used in a browser
IDE, a script, or someone else's client does not, and neither does anything that
keeps no local record. The figure is therefore a **floor, not a total** — stated
in this file, `DESIGN.md` and `docs/cross-machine-setup.md` rather than on every
render, because standing prose beside a number is read as noise.

One blind spot is measured rather than guessed at: the **web-search path** issues
its own request straight to the provider and records no usage anywhere, so
neither this plugin nor DSH's own `tokenUsage` projection can weigh it. The
diagnostic tool counts those calls (`node tools/tracked-report.mjs`) so the floor
has a concrete edge, and nothing is estimated in their place.

```
┌──────────────────────────────┐
│  ▮▮  我的 key · 本月   3.61亿  │   ← this plugin
│  ⚙   Settings                 │
└──────────────────────────────┘
```

Click the row for the breakdown: which machine contributed what, the platform
split (this DSH home, opencode, Pen, WorkBuddy — each only when it has a record
this month), and — only when something is actually being left out — a warning
naming it. The per-model split and the machine's all-time
bucket breakdown are computed but not shown: the panel answers "how much, and
from where", and nothing else.

## Install

```sh
dsh plugin --profile web add github:greyhackintoch-dev/dsh-month-tokens
```

No build step, so there is no `allowBuilds` approval to answer. Restart
`dsh web` afterwards.

### Install through the agent instead

Prefer not to touch a terminal? Paste this into any DSH session:

```
Install the dsh-month-tokens plugin by running:

dsh plugin --profile web add github:greyhackintoch-dev/dsh-month-tokens

Then confirm dsh-month-tokens appears in ~/.dsh/profiles/web/package.json
under dsh.profile.bundles, and remind me to restart dsh web for it to take
effect.
```

The command writes outside the agent's workspace sandbox, so expect a single
approval prompt. `dsh plugin` reconciles the package into `dsh.profile.bundles`
by itself — the bundle declares `dsh.bundle`, so its `cordis.patch.yml` is
applied with no further configuration.

### Requires a browser-shell DSH (`web` profile)

The browser half runs in a page with a real origin. Two consequences:

**The official DSH Desktop app is not supported.** `dsh plugin` refuses its
reserved profile outright:

```
$ dsh plugin --profile desktop add github:greyhackintoch-dev/dsh-month-tokens
error: profile "desktop" is managed exclusively by the Electron application
```

Installing it there by other means would not help either. The browser half
streams over a plain HTTP route (`GET /token-ledger/stream`), while the Electron
shell loads the frontend from `file://` and carries every bit of DSH's own
client I/O through `window.__DSH_TRANSPORT__` instead. Under `file://` a relative
URL has no host to resolve against — the shell's own code detects this, since
`location.origin` is the string `"null"` — and nothing exposes the loopback port
to the renderer, so there is no absolute URL to fall back to.

**Third-party desktop wrappers that embed the standard web profile do work.**
If the client is a BrowserWindow pointed at the local web GUI, it is an ordinary
browser context, and the command above is all that is needed.

## What makes it different

Most usage plugins show you a number. This one also tells you **how much of the
month it could not attribute**, and refuses to invent the difference.

DSH ships no projection that buckets usage by day — every shipped unit is either
cumulative (`tokenUsage`) or a snapshot of the present (`contextPressure`,
`contextBreakdown`, `sessionStats`). A cumulative per-session figure cannot be
reconstructed into "how much of this happened after the 1st". So each session is
decided by the first rule that applies, and the rule used is reported:

| Rule | Condition | Result | Accuracy |
| --- | --- | --- | --- |
| `ledger` | an optional per-day ledger covers the month | sum the days with this month's prefix | exact |
| `born` | created at or after the 1st | its whole total | exact |
| `idle` | created earlier, last user prompt before the 1st | 0 | exact |
| `split` | created earlier **and** prompted this month | 0, and counted in `unattributed` | **unknown** |

A long-running session that spans the boundary lands in `split`, and that is
exactly the case where a naive counter silently reports too little. When any
session lands there, `local.exact` is `false`, `local.unattributed` says how
many, and the panel says so in the warning colour.

To resolve the remaining cases exactly, add a per-day activity projection. The
community [`dsh-context`](https://github.com/) plugin contributes one named
`contextActivity`; when it is mounted, the `ledger` rule takes over
automatically and no session is left ambiguous. Measured on a real 79-session
home it covered 78 sessions exactly, the exception being a session checkpointed
before that plugin existed. **This plugin has no dependency on it** — it is an
optional upgrade, and everything works without it.

## What it counts

| Source | Where it comes from | Latency |
| --- | --- | --- |
| **This DSH home** | per-session `tokenUsage` projections | live — pushed on every settled turn |
| **This key, this home** | session logs, read incrementally frame by frame | a poll, up to ~1 minute behind |
| **opencode** | its own SQLite database, read-only | a poll, up to ~1 minute behind |
| **Pen** | `~/.pencil/pi-sessions/*.jsonl` | a poll, up to ~1 minute behind |
| **WorkBuddy** | `~/.workbuddy/projects/**/*.jsonl` | a poll, up to ~1 minute behind |
| **Peer machines** | their reports to your aggregator, if you run one | their poll interval |

Everything except the peer row is local, and the plugin issues **no outbound
HTTP request unless you configure a reporter** (`role: reporter`/`both` with an
`aggregatorUrl`). None of those three clients' calls pass through DSH, so reading
what they wrote is the only way to see them.

### Why the session log is read at all

The shipped `tokenUsage` projection cannot say *which key* spent anything: its
state is four buckets and a `(turn, step)` slot, with no provider, model, or
credential in it. The durable session log can — `request/context` records the
provider and model, and each settled `assistant/message` carries its own usage
and timestamp — so it is read incrementally (the log is a sequence of
independent zstd frames, and a scan resumes at the first byte it has not
consumed) and folded with the projection's own replacement rule, retries
included.

Two consequences worth knowing:

- **Month attribution gets better, not worse.** Dating each event means a
  session that spans the 1st is split correctly instead of being reported as
  unattributable.
- **Route names are matched broadly on purpose.** Provider routes are an open
  set: the shipped adapter registers `deepseek-official`, and plugins register
  more (`vision-toolkit-deepseek-*`, `modlens-deepseek` were all measured
  spending one key). A whitelist silently misses the next plugin to add a
  route — measured cost of getting this wrong: 1,564,298 tokens in one month.
  Breadth is safe because the bucket is settled by the key fingerprint, not the
  route name; and anything no target claims is listed in the panel as
  `uncovered` rather than assumed away.

### One key, every machine

Give two or more machines the same `trackKeys` and point the others at one of
them:

```yaml
# the aggregator (an always-on machine)
- insert:
    - id: token-ledger
      name: dsh-month-tokens
      config:
        role: both
        collectorHost: 0.0.0.0
        collectorPort: 3939
        collectorToken: !!js process.env.DSH_TOKEN_LEDGER_TOKEN
        trackKeys:
          - ref: DEEPSEEK_API_KEY
            providers: [deepseek-official]
            providerPatterns: ['deepseek']

# every other machine
- insert:
    - id: token-ledger
      name: dsh-month-tokens
      config:
        role: reporter
        aggregatorUrl: http://192.168.1.244:3939
        collectorToken: !!js process.env.DSH_TOKEN_LEDGER_TOKEN
        trackKeys: [{ ref: DEEPSEEK_API_KEY, providerPatterns: ['deepseek'] }]
```

Each machine reports the **whole current value** of its own buckets, never a
delta, and the aggregator keeps the newest snapshot per `(machine, key)`. A
resend, a duplicate, an out-of-order arrival, or an aggregator restart therefore
cannot inflate the total — and a machine that is switched off keeps its last
number, marked `stale`, instead of vanishing from the sum.

The aggregator listens on **its own port with its own bearer token**, never on
the GUI's. Enabling this must not require `networkExposure`, which would publish
every other route along with it; a collector with no token refuses to start
rather than serving openly.

Step-by-step deployment, including verification and a troubleshooting table, is
in [`docs/cross-machine-setup.md`](docs/cross-machine-setup.md). To see the
number without starting DSH at all:

```sh
node tools/tracked-report.mjs           # per day, per model, uncovered routes
```

### opencode

opencode writes one row per assistant message into
`~/.local/share/opencode/opencode.db`, whose `data` JSON carries
`tokens: { input, output, reasoning, cache: { read, write }, total }`. The
columns line up with this ledger's vocabulary almost exactly:

| Ledger bucket | opencode field |
| --- | --- |
| `uncachedInputTokens` | `tokens.input` — **uncached**; cache reads are separate |
| `cacheReadTokens` | `tokens.cache.read` |
| `cacheWriteTokens` | `tokens.cache.write` |
| `outputTokens` | `tokens.output` **+ `tokens.reasoning`** |

`reasoning` is the one translation: opencode reports it apart from `output`,
while DSH folds it in, so the two are summed to keep the rows comparable.

Rows are filtered by `providerID` (`deepseek` by default) and by
`time_created >= 本月 1 日`. The database is opened read-only and closed on every
poll — it is a third-party schema under active WAL writes, so holding a handle
buys nothing and risks a stale snapshot.

**With `trackKeys` configured, opencode is attributed by key, not by name.**
opencode keeps the raw key per provider in its own `auth.json`, so two machines
can both say `deepseek` while only one of them holds the key being tracked — the
normal case on a shared company account. The plugin fingerprints that stored key
and folds opencode's rows into the tracked key's own day and model buckets only
when the fingerprints match. A provider holding a different key is reported as
`tracked.opencode.state: 'otherKey'` and excluded, rather than silently inflating
your number. Override the store's location with `opencodeAuthPath` (or
`DSH_TOKEN_LEDGER_OPENCODE_AUTH`) if it lives elsewhere.

**Requirements:** Node 22.5+ for `node:sqlite`. On an older runtime the plugin
still runs; it reports that opencode cannot be read instead of quietly counting
zero.

### Pen and WorkBuddy

Two more clients that keep a real local record, read the same way: find the
credential they store, fingerprint it, and read only the rows that credential
paid for.

| | Credential (for the fingerprint) | Usage record | Shape |
| --- | --- | --- | --- |
| **Pen** | `~/.pencil/agent-auth` — `{ provider: { type, key } }` | `~/.pencil/pi-sessions/*.jsonl` | pi-ai |
| **WorkBuddy** | `~/.workbuddy/models.json` — `[{ id, apiKey, … }]` | `~/.workbuddy/projects/**/*.jsonl` | DeepSeek wire |

Pen's store is the *same shape* as opencode's, so it is parsed by the same code
rather than a second parser that could drift from it.

WorkBuddy's is a list of its own configured providers, and its usage rows carry
**no key at all** — so the join is structural, in two steps:

```
providerData.requestModelId == 'custom-local:' + models.json[].id
      └─▶ that entry's apiKey ─▶ fingerprint ─▶ is it the tracked key?
```

WorkBuddy's own gateway routes (`auto`, `hy3`) never appear in `models.json`, so
they fall out of that join on their own. Measured on a real store: 100 of 122
rows are gateway calls — **30.6% of the month** — and none of them reach the
number. The exclusion is structural; no field name is consulted to decide it.

**Reasoning tokens are counted three different ways, and only opencode's is
additive.** All three readers are asserted against the same fixture so the
difference cannot be inherited by accident:

| | Reason | Result |
| --- | --- | --- |
| opencode | reports `reasoning` separately | **added** to output |
| Pen | `input + output + cacheRead + cacheWrite === totalTokens`, so reasoning is already inside `output` | **not added** |
| WorkBuddy | `completion_tokens_details.reasoning_tokens` is a subset of `completion_tokens` | **not added** |

Likewise, `prompt_tokens` and WorkBuddy's `usage.inputTokens` *include* cache
hits, so neither is ever used as uncached input; the buckets come from the
`prompt_cache_*` fields.

**Three limits worth knowing:**

1. **Not real-time.** opencode records usage when a message *completes*, so the
   best available cadence is a 60-second poll. The DSH number is genuinely live.
2. **Private schema.** `message.data` is an opencode implementation detail that
   any release can change. A schema that still queries but yields no token
   fields is reported as `drift`, never as a smaller month.
3. **Provider, not key.** `providerID: 'deepseek'` names the provider, not the
   credential. Same key in both tools → correct. Swap in a different DeepSeek
   key in opencode and the two are silently merged.

Override the location or the provider list in the plugin's entry:

```yaml
- insert:
    - id: token-ledger
      name: 'dsh-month-tokens'
      config:
        opencodeDbPath: /custom/path/opencode.db
        opencodeProviders: [deepseek]
        penAuthPath: /custom/path/agent-auth
        penSessionsDir: /custom/path/pi-sessions
        workbuddyModelsPath: /custom/path/models.json
        workbuddyProjectsDir: /custom/path/projects
```

`DSH_TOKEN_LEDGER_OPENCODE_DB` overrides the path when no config is given.

### The panel

Clicking the sidebar row opens a panel that answers two questions — how much,
and where from:

- the headline: your key's month total, summed across every machine reporting it;
- under it, that key's all-time figure and a **7-day chart** of its daily use;
- then each machine's contribution for the month, stale ones kept and labelled;
- then, under 本月消耗, where the machine's own usage went: DSH, opencode, Pen,
  WorkBuddy — the last three only when they actually have a record.

The chart is drawn from the same month-scoped `days` the rest of the panel uses,
over a **calendar** axis — seven days, not "the seven days that happen to have
records". Inside the month an absent day is a real zero and is drawn as one;
before the month start it is *unknown* and is left out rather than zeroed, so
early in a month the window is short and says so (`Last 3 days`, `10/1–10/3`).
Ticks show the day alone, because `days` is month-scoped by contract and every
point on the axis is therefore in the same month.

It is one hand-written SVG path — no chart library, and nothing extra crosses
the wire for it.

## Routes

| Route | Body |
| --- | --- |
| `GET /token-ledger/stream` | SSE; one `ledger` event per movement, plus `: keep-alive` every 25s |
| `GET /token-ledger/summary` | the same payload as one JSON document |

```json
{
  "revision": 6,
  "period":  { "kind": "month", "key": "2026-09", "start": 1788192000000, "end": 1790294400000 },
  "month":   361262338,
  "totals":  { "uncachedInputTokens": 3944544, "outputTokens": 2456933, "cacheReadTokens": 269710720, "cacheWriteTokens": 0 },
  "local":   { "total": 346169232, "month": 346169232, "monthSource": "mixed", "exact": true, "unattributed": 0 },
  "tools": {
    "opencode": { "state": "ok", "messages": 98, "fetchedAt": 1790231906819,
      "totals": { "uncachedInputTokens": 1700628, "outputTokens": 77406, "cacheReadTokens": 13315072, "cacheWriteTokens": 0 } }
  },
  "sessions": { "counted": 79, "live": 2, "skippedSeeded": 0, "scannedAt": 1790229233573 }
}
```

`month` is the headline. `totals` is the **all-time** DSH bucket breakdown,
shown in the panel under a 本机历史累计（仅 DSH） caption. `monthSource` is
`ledger`, `born`, `idle`, `mixed`, or `none`; each `tools.*.state` is
`loading`, `ok`, `absent`, `drift`, `unavailable`, or `error`.

```sh
curl -s http://127.0.0.1:3080/token-ledger/summary | python3 -m json.tool
```

## Why the period needs no stored counter

The window is derived from the clock on every read:

```
start = 本月 1 日 00:00（本地时间）
end   = 明天 00:00
```

There is no accumulated total and no reset job, so a process that slept through
midnight on the 1st still reports the new month the moment it next looks, and no
reset can be missed. A timer also fires at the boundary so an open panel turns
over immediately rather than waiting for the next turn or rescan.

## Development

```sh
npm test        # node test/host.test.mjs && node test/client.test.mjs
```

The suite is dependency-free, offline, and hermetic: it points the plugin at a
paths that cannot exist, so it can never read your real opencode, Pen, or
WorkBuddy stores.

To mount a working copy instead of the installed package, insert it by absolute
path — `dsh` converts absolute paths inside `insert` rows to file URLs, and the
client-module scanner walks up from the entry file to the nearest
`package.json`:

```yaml
- insert:
    - id: token-ledger
      name: /absolute/path/to/dsh-month-tokens/lib/index.js
```

Use either the bundle or the path insert, never both — the `token-ledger` id
would collide and the duplicate route registration would fail loudly.

**Restart `dsh web` after editing the host half.** Profiles with
`patchReload: live` recompose on a patch edit, but the host module is a plain
ESM import and stays in the module cache. The browser half is read from disk, so
a page refresh is enough for it.

### How it is put together

- `lib/index.js` — the host half. Folds DSH's projections, reads the three
  third-party stores, and
  serves the two routes. No dependencies beyond Node builtins.
- `client/client.js` — the browser half, hand-bundled for the DSH client module
  loader (`window.__ModuleLoader__.load({ id, factory })`). It requires only the
  platform seed words `react` and `react-dom`, registers one entry into the
  `sidebar.footer.action` list slot, opens one `EventSource`, and renders whole
  values the host computed. No domain folding happens in the browser.

Counts render in Chinese myriad units — `999`, `2.95万`, `2.77亿` — with the
exact integer on hover.

## Cost

- Cold scan on boot and every 60s: one `sessionPersistence.list()` (a directory
  walk plus a `stat` per session) and one in-memory `cachedSnapshot` per cold
  session. **No session log is ever read.**
- One read-only `COUNT`/`SUM` over opencode's `message` table per minute.
- An idle rescan does not republish, so a quiet ledger never re-renders an open
  panel. `fetchedAt` is deliberately excluded from the change comparison —
  including it would bump the revision once a minute forever.

## Security

The two routes answer without the `dsh web` launch-token exchange, because the
webserver's named-route table is not behind that guard. That is acceptable here:
the webserver binds to `127.0.0.1` by default, the payload is aggregate counts
rather than session content, and no `access-control-allow-origin` header is
sent, so a cross-origin page cannot read the body. If you deliberately expose
the GUI with `networkExposure: 0.0.0.0`, these two routes become reachable by
anyone who can reach the port.

The plugin reads four things off disk: DSH's own session projections, the
session logs (incrementally, for key attribution), opencode's `message` table,
and — when `trackKeys` is configured — opencode's `auth.json`, from which it
takes the stored key **only to hash it**. What it computes is a fingerprint; the
key is never returned, logged, written, or put in a payload. Nothing opens a
database for writing, and no credential or message body reaches a payload or a
log line — only counts.

### What crosses the wire, when you run an aggregator

Instance label, the key's **sha256 fingerprint**, bucket counts, and timestamps.
No key, no prompt, no model output, no session content. The fingerprint is still
a key-derived value, so the aggregator logs only its first 8 characters.
Resolution failures are reported as reasons (`missing`, `empty`,
`illegalCharacters`, `resolveFailed`, `invalidPattern`) — never as a smaller
month, and never as the value that failed.

## License

MIT
