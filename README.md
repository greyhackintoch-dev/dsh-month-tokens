# dsh-month-tokens

A DeepSeek Harness plugin that puts **one calendar month of token usage** in the
sidebar, directly above Settings. It counts this DSH home and opencode, reads
only local data, and resets at 00:00 on the 1st.

```
┌──────────────────────────────┐
│  ▮▮  本月消耗Token    3.61亿  │   ← this plugin
│  ⚙   Settings                 │
└──────────────────────────────┘
```

Click the row for the breakdown.

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
| **opencode** | its own SQLite database, read-only | a poll, up to ~1 minute behind |

Both are local. The plugin makes **no HTTP request of any kind**: opencode's
calls never pass through DSH, so reading its database is the only way to see
them.

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

**Requirements:** Node 22.5+ for `node:sqlite`. On an older runtime the plugin
still runs; it reports that opencode cannot be read instead of quietly counting
zero.

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
```

`DSH_TOKEN_LEDGER_OPENCODE_DB` overrides the path when no config is given.

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
`ledger`, `born`, `idle`, `mixed`, or `none`; `tools.opencode.state` is
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
path that cannot exist, so it can never read your real opencode database.

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

- `lib/index.js` — the host half. Folds DSH's projections, reads opencode, and
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

The plugin reads exactly two things off disk: DSH's own session projections, and
opencode's `message` table. It never reads opencode's `auth.json`, never opens
that database for writing, and never puts a credential or a message body into a
payload or a log line — only counts.

## License

MIT
