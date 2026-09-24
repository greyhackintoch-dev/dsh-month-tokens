/**
 * dsh-month-tokens — browser half.
 *
 * Renders this month's token counter as a sidebar footer action, in the seat
 * directly above Settings. The number arrives over a server-sent-event stream
 * the host half owns, so it moves as soon as any turn settles; the host is the
 * only computation site and this half renders whole values.
 *
 * Bundled by hand for the DSH client module loader: executing this script only
 * REGISTERS the factory, and every side effect — including CSS injection —
 * lives inside it and runs at materialization.
 */
window.__ModuleLoader__.load({
  id: 'dsh-month-tokens',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const react = require('react');
    const reactDom = require('react-dom');
    const h = react.createElement;

    /** Dictionary namespace owned by this plugin. */
    const NS = 'tokenLedger';
    /** The host half's live ledger stream. */
    const STREAM_URL = '/token-ledger/stream';
    /** CSS injection key, so a re-materialization does not stack style tags. */
    const CSS_KEY = 'dsh-month-tokens/styles';

    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'row.title': '本月消耗Token',
      'row.title.tracked': '我的 key · 本月',
      'row.value': '{count}',
      'row.pending': '统计中',
      'panel.title': '本月消耗 Token',
      'panel.title.tracked': '我这把 key 的消耗',
      'panel.subtitle.dsh': '仅本机 DSH · {period} 起',
      'panel.subtitle.tools': '本机 DSH + opencode · {period} 起',
      'panel.subtitle.tracked': '按 key 归集 · {period} 起',
      'panel.coverage': '覆盖范围：仅 DSH + opencode。同一把 key 用在其他客户端（Cursor、脚本等）不在此列，因此这是下界，不是总量。',
      'panel.group.month': '本月消耗',
      'panel.group.tracked': '我的 key（跨机归集）',
      'panel.group.peerKeys': '对端上报的其他 key（不计入上方）',
      'panel.group.models': '按模型',
      'panel.key.label': '{short} · {ref}',
      'panel.key.allTime': '该 key 历史累计',
      'panel.key.routes': '{count} 个路由',
      'panel.instance.stale': '陈旧',
      'panel.instance.label': '{label} · {age}',
      'panel.age.now': '刚刚',
      'panel.age.minutes': '{count} 分钟前',
      'panel.age.hours': '{count} 小时前',
      'panel.age.days': '{count} 天前',
      'panel.note.uncovered': '有 {count} 个路由出现在会话日志里，但不属于任何被跟踪的 key，其用量未计入：{list}。',
      'panel.note.uncovered.hint': '把它们加进该 key 配置的 providers 或 providerPatterns，下次扫描即会计入。',
      'panel.note.failure.missing': '凭证 {ref} 取不到值，这把 key 无法统计。',
      'panel.note.failure.empty': '凭证 {ref} 的值为空，这把 key 无法统计。',
      'panel.note.failure.illegalCharacters': '凭证 {ref} 含 HTTP 头无法承载的字符，这把 key 无法统计。',
      'panel.note.failure.resolveFailed': '凭证 {ref} 读取失败（{detail}），这把 key 无法统计。',
      'panel.note.failure.invalidPattern': '凭证 {ref} 的 providerPatterns 里有无法编译的模式（{detail}），该模式已忽略。',
      'panel.note.failure.other': '凭证 {ref} 无法解析（{reason}），这把 key 无法统计。',
      'panel.collector.on': '聚合器 · {host}:{port} · 已收 {count} 台',
      'panel.collector.starting': '聚合器正在启动…',
      'panel.collector.other': '聚合器状态：{state}',
      'panel.collector.error': '聚合器异常（{state}）',
      'panel.reporter.on': '上报 · {url} · 最后 {age}',
      'panel.reporter.idle': '上报已就绪 · {url} · 暂无可报数据',
      'panel.reporter.noUrl': '上报已开启，但没有配置聚合器地址。',
      'panel.reporter.unsupported': '当前运行时没有 fetch，无法上报到 {url}。',
      'panel.reporter.other': '上报状态：{state}',
      'panel.reporter.error': '上报失败（{state}）',
      'panel.group.history': '本机历史累计（仅 DSH）',
      'panel.localMonth': '本机 DSH',
      'panel.opencode': 'opencode',
      'panel.opencodeMessages': '{count} 条消息',
      'panel.historyTotal': '合计',
      'panel.uncachedInput': '未缓存输入',
      'panel.cacheRead': '缓存命中',
      'panel.cacheWrite': '缓存写入',
      'panel.output': '输出',
      'panel.sessions': '计入会话',
      'panel.sessions.value': '{counted} 个（{live} 个在运行）',
      'panel.skipped': '另有 {count} 个分叉会话无法离线核对，未计入。',
      'panel.stale': '与主机连接中断，显示的是最后一次同步的值。',
      'panel.empty': '还没有任何提供商上报的用量。',
      'panel.note.month': '统计周期是本地时间的自然月，每月 1 日 00:00 自动归零。',
      'panel.note.ledger': '本月数据按日历日精确汇总。',
      'panel.note.exact': '本月数据不含估算，按会话创建时间与最后提问时间逐会话判定。',
      'panel.note.split': '有 {count} 个会话创建于本月之前、本月又用过，累计值无法拆分月份归属，未计入本月。',
      'panel.note.opencode': 'opencode 用量按消息完成落库，最多滞后约 1 分钟。',
      'panel.note.opencode.absent': '未找到 opencode 数据库，其用量未计入。',
      'panel.note.opencode.drift': 'opencode 数据库结构已变化，读不出 token，其用量未计入。',
      'panel.note.opencode.unavailable': '当前运行时没有 node:sqlite，无法读取 opencode 用量。',
      'panel.note.opencode.error': 'opencode 用量读取失败：{message}',
    };

    /** English dictionary, checked complete against the zh key set. */
    const en = {
      'row.title': 'Month tokens',
      'row.title.tracked': 'My key · this month',
      'row.value': '{count}',
      'row.pending': 'Measuring',
      'panel.title': 'Token usage this month',
      'panel.title.tracked': 'Usage for my key',
      'panel.subtitle.dsh': 'This DSH home only · since {period}',
      'panel.subtitle.tools': 'This DSH home + opencode · since {period}',
      'panel.subtitle.tracked': 'Gathered by key · since {period}',
      'panel.coverage': 'Coverage: DSH + opencode only. The same key used from other clients (Cursor, scripts, and the like) is not counted, so this is a floor rather than a total.',
      'panel.group.month': 'This month',
      'panel.group.tracked': 'My keys (gathered across machines)',
      'panel.group.peerKeys': 'Other keys reported by peers (not counted above)',
      'panel.group.models': 'By model',
      'panel.key.label': '{short} · {ref}',
      'panel.key.allTime': 'This key, all time',
      'panel.key.routes': '{count} routes',
      'panel.instance.stale': 'stale',
      'panel.instance.label': '{label} · {age}',
      'panel.age.now': 'just now',
      'panel.age.minutes': '{count} min ago',
      'panel.age.hours': '{count} h ago',
      'panel.age.days': '{count} d ago',
      'panel.note.uncovered': '{count} route(s) appeared in the session logs but belong to no tracked key, so their usage is not counted: {list}.',
      'panel.note.uncovered.hint': 'Add them to that key\u2019s providers or providerPatterns to include them from the next scan.',
      'panel.note.failure.missing': 'Credential {ref} resolves to nothing, so this key cannot be counted.',
      'panel.note.failure.empty': 'Credential {ref} is empty, so this key cannot be counted.',
      'panel.note.failure.illegalCharacters': 'Credential {ref} contains characters no HTTP header can carry, so this key cannot be counted.',
      'panel.note.failure.resolveFailed': 'Reading credential {ref} failed ({detail}), so this key cannot be counted.',
      'panel.note.failure.invalidPattern': 'Credential {ref} has a providerPatterns entry that does not compile ({detail}); that pattern was ignored.',
      'panel.note.failure.other': 'Credential {ref} could not be resolved ({reason}), so this key cannot be counted.',
      'panel.collector.on': 'Aggregator · {host}:{port} · {count} machine(s) reporting',
      'panel.collector.starting': 'Aggregator is starting\u2026',
      'panel.collector.other': 'Aggregator state: {state}',
      'panel.collector.error': 'Aggregator failed ({state})',
      'panel.reporter.on': 'Reporting · {url} · last {age}',
      'panel.reporter.idle': 'Reporter ready · {url} · nothing to send yet',
      'panel.reporter.noUrl': 'Reporting is on, but no aggregator URL is configured.',
      'panel.reporter.unsupported': 'This runtime has no fetch, so nothing can be reported to {url}.',
      'panel.reporter.other': 'Reporting state: {state}',
      'panel.reporter.error': 'Reporting failed ({state})',
      'panel.group.history': 'This home, all time (DSH only)',
      'panel.localMonth': 'This DSH home',
      'panel.opencode': 'opencode',
      'panel.opencodeMessages': '{count} messages',
      'panel.historyTotal': 'Total',
      'panel.uncachedInput': 'Uncached input',
      'panel.cacheRead': 'Cache read',
      'panel.cacheWrite': 'Cache write',
      'panel.output': 'Output',
      'panel.sessions': 'Sessions counted',
      'panel.sessions.value': '{counted} ({live} live)',
      'panel.skipped': '{count} forked session(s) could not be verified offline and are excluded.',
      'panel.stale': 'Disconnected from the host; showing the last synced value.',
      'panel.empty': 'No provider-reported usage yet.',
      'panel.note.month': 'The period is the local calendar month; the counter resets at 00:00 on the 1st.',
      'panel.note.ledger': 'This month is summed per calendar day.',
      'panel.note.exact': 'This month contains no estimate: each session was decided from its creation time and last prompt time.',
      'panel.note.split': '{count} session(s) were created before this month and used in it; a cumulative total cannot be split across the boundary, so they are not counted.',
      'panel.note.opencode': 'opencode records usage when a message completes, so this can lag by up to a minute.',
      'panel.note.opencode.absent': 'No opencode database was found; its usage is not counted.',
      'panel.note.opencode.drift': 'The opencode database schema has changed and no tokens could be read; its usage is not counted.',
      'panel.note.opencode.unavailable': 'This runtime has no node:sqlite, so opencode usage cannot be read.',
      'panel.note.opencode.error': 'Reading opencode usage failed: {message}',
    };

    /** Fallback copy, so a missing locale seat still renders real words. */
    const fallback = (key) => zh[key] ?? key;

    const CSS = [
      '.dsh-month-tokens-layer{flex:none;align-items:center;width:100%;height:42px;margin:8px 0 0;display:flex;position:relative}',
      '.dsh-month-tokens-badge{width:calc(100% + 4px);height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:0 10px 0 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;text-align:left}',
      '.dsh-month-tokens-badge:hover,.dsh-month-tokens-badge[data-active]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-month-tokens-badge:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:-2px}',
      // No colour of its own: the glyph inherits the badge's label-primary,
      // exactly as the Settings gear inherits its trigger's. Declaring a
      // tint here is what made the two rows disagree.
      '.dsh-month-tokens-glyph{flex:none;justify-content:center;align-items:center;display:inline-flex}',
      '.dsh-month-tokens-label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.dsh-month-tokens-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none;margin-left:auto;font-size:12px;line-height:16px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-layer[data-rail]{width:36px;height:36px;margin:0}',
      '.dsh-month-tokens-layer[data-rail] .dsh-month-tokens-badge{corner-shape:round;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;padding:0}',
      '.dsh-month-tokens-layer[data-rail] .dsh-month-tokens-count{display:none}',
      '.dsh-month-tokens-panel{z-index:40;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));width:312px;max-width:calc(100vw - 24px);max-height:calc(100vh - 120px);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}',
      '.dsh-month-tokens-head{box-sizing:border-box;flex-direction:column;gap:2px;padding:12px 12px 10px;display:flex}',
      '.dsh-month-tokens-grand{color:var(--dsw-alias-label-primary);font-size:26px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-grandSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}',
      '.dsh-month-tokens-rule{height:1px;background:var(--dsw-alias-border-l2);flex:none}',
      '.dsh-month-tokens-body{flex:1 1 auto;min-height:0;overflow:auto;flex-direction:column;gap:0;padding:6px 12px 10px;display:flex}',
      '.dsh-month-tokens-caption{color:var(--dsw-alias-label-caption);letter-spacing:.04em;padding:6px 0 2px;font-size:11px;font-weight:500;line-height:16px}',
      '.dsh-month-tokens-item{align-items:baseline;gap:12px;padding:4px 0;display:flex}',
      '.dsh-month-tokens-itemLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;flex:1;min-width:0}',
      '.dsh-month-tokens-itemValue{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-item[data-strong] .dsh-month-tokens-itemLabel{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-month-tokens-note{color:var(--dsw-alias-label-tertiary);padding:6px 12px 0;font-size:11px;line-height:16px}',
      '.dsh-month-tokens-note[data-warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}',
      // The tracked-key block nests instances and models under their key, so
      // the indent is the only thing saying which total owns which rows.
      '.dsh-month-tokens-subrows{padding-left:10px;flex-direction:column;display:flex}',
      // A stale peer keeps its number and loses none of its emphasis — it is
      // tinted instead, because deleting or dimming a real figure would read
      // as "nothing here" rather than "last known".
      '.dsh-month-tokens-item[data-stale] .dsh-month-tokens-itemLabel,.dsh-month-tokens-item[data-stale] .dsh-month-tokens-itemValue{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}',
      // The coverage declaration is pinned below the scrolling body: it is a
      // standing statement about what the number above it can and cannot see,
      // so it must not scroll out of sight.
      '.dsh-month-tokens-note[data-coverage]{padding-top:8px}',
    ].join('');

    /** Inject this plugin's stylesheet once per document. */
    function ensureStyles() {
      if (document.querySelector(`style[data-dsh-css="${CSS_KEY}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.dshCss = CSS_KEY;
      tag.textContent = CSS;
      document.head.append(tag);
    }

    /**
     * Token count in Chinese myriad units: 9,999 exact, 12.3万, 2.77亿.
     *
     * The unit tier is 万 (10^4) below 亿 (10^8) rather than 亿 alone, so a
     * small figure stays a readable number instead of collapsing to 0.00亿.
     * @param value - non-negative token count.
     * @returns display text.
     */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      if (value < 1e4) return String(value);
      const units = [
        [1e8, '亿'],
        [1e4, '万'],
      ];
      for (const [size, suffix] of units) {
        if (value < size) continue;
        return `${trimZeros((value / size).toFixed(2))}${suffix}`;
      }
      return String(value);
    }

    /**
     * Drop a fixed-point fraction's trailing zeros: 2.70 -> 2.7, 10.00 -> 10.
     * @param text - a fixed-point string.
     * @returns the trimmed string.
     */
    function trimZeros(text) {
      return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
    }

    /**
     * Exact token count with grouping separators, for hover detail.
     * @param value - token count.
     * @returns display text.
     */
    function formatExact(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
      return value.toLocaleString('en-US');
    }

    /**
     * The ledger glyph: four ascending usage bars.
     *
     * Drawn to fill its 16px box so it sits optically level with the 16px
     * Settings gear directly below it rather than reading as a smaller mark.
     * @returns the glyph element.
     */
    function LedgerGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', {
          d: 'M2.6 13.1V10.1M6.2 13.1V7M9.8 13.1V9.1M13.4 13.1V4.2',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      );
    }

    /**
     * One label/value row.
     * @param props - label, a raw token count or pre-formatted text, emphasis, hover detail, and the stale mark.
     * @returns the row element.
     */
    function Item({ label, tokens, text, strong, hint, stale }) {
      const value = tokens === undefined ? text : formatTokens(tokens);
      const title = [tokens === undefined ? undefined : formatExact(tokens), hint].filter((part) => part !== undefined).join(' · ');
      return h(
        'div',
        {
          className: 'dsh-month-tokens-item',
          ...(strong === true ? { 'data-strong': '' } : {}),
          ...(stale === true ? { 'data-stale': '' } : {}),
        },
        h('span', { className: 'dsh-month-tokens-itemLabel' }, label),
        h('span', { className: 'dsh-month-tokens-itemValue', ...(title === '' ? {} : { title }) }, value === undefined ? '—' : value),
      );
    }

    /**
     * Sum the four disjoint buckets.
     * @param buckets - a bucket set, possibly absent.
     * @returns total tokens, or undefined when there is no bucket set.
     */
    function sumBuckets(buckets) {
      if (buckets === undefined || buckets === null) return undefined;
      return buckets.uncachedInputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens + buckets.outputTokens;
    }

    /**
     * One section caption.
     * @param props - the caption text.
     * @returns the caption element.
     */
    function Caption({ children }) {
      return h('div', { className: 'dsh-month-tokens-caption' }, children);
    }

    /**
     * The host's link vocabulary, rendered as words.
     *
     * These are the states the host actually publishes — the collector
     * (`off`/`starting`/`listening`/`error` plus a start-failure reason) and the
     * reporter (`off`/`idle`/`noUrl`/`unsupported`/`ok`/`error`). A Map, not an
     * object literal, so a state word that collides with an `Object.prototype`
     * member can never resolve to a function instead of copy.
     */
    const LINK_COPY = new Map([
      ['collector', new Map([
        ['listening', 'panel.collector.on'],
        ['starting', 'panel.collector.starting'],
        ['error', 'panel.collector.error'],
      ])],
      ['reporter', new Map([
        ['ok', 'panel.reporter.on'],
        ['error', 'panel.reporter.error'],
        // `idle` is the reporter's steady state when there is nothing tracked
        // to send; it is reported rather than hidden, because a missing
        // reporting line reads as "not configured".
        ['idle', 'panel.reporter.idle'],
        ['noUrl', 'panel.reporter.noUrl'],
        ['unsupported', 'panel.reporter.unsupported'],
      ])],
    ]);
    /** Link states that mean the link is switched off, warranting no row. */
    const LINK_SILENT = new Set(['off', 'disabled', 'none', '']);
    /**
     * Link states that are working as configured but broken in fact: a
     * refused delivery, a missing `fetch`, or reporting switched on with no
     * address to report to. These get the warning colour — they all mean the
     * cross-machine figure is silently running on this machine alone.
     */
    const LINK_WARN = new Set(['error', 'unsupported', 'noUrl']);

    /**
     * Classify one collector/reporter state word.
     *
     * The host owns this vocabulary and may grow it, so an unrecognised state
     * still renders — it is reported verbatim rather than folded into either
     * "fine" or "broken", because guessing either way would misinform.
     * @param kind - `collector` or `reporter`.
     * @param state - the state word the host sent.
     * @returns a dictionary key and whether it warrants the warning colour, or
     *   `undefined` when the link is off and no row should be drawn.
     */
    function linkStateKey(kind, state) {
      if (typeof state !== 'string' || LINK_SILENT.has(state)) return undefined;
      const key = LINK_COPY.get(kind)?.get(state) ?? `panel.${kind}.other`;
      return { key, warn: LINK_WARN.has(state) };
    }

    /**
     * A coarse "how long ago" phrase.
     * @param tr - the translator.
     * @param ms - an age in milliseconds.
     * @returns the phrase, or `undefined` when the age is unusable.
     */
    function ageText(tr, ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
      const minutes = Math.floor(ms / 60000);
      if (minutes < 1) return tr('panel.age.now');
      if (minutes < 60) return tr('panel.age.minutes', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return tr('panel.age.hours', { count: hours });
      return tr('panel.age.days', { count: Math.floor(hours / 24) });
    }

    /**
     * The month figure for one tracked key.
     *
     * The host sends both a month figure and an all-time bucket set, and they
     * are deliberately different periods: `totals` mirrors the local all-time
     * figure, while `days` and `models` are already scoped to the month. The
     * month number is therefore taken from `month`, and only if a host omits
     * it does the fallback sum `days` — which is month-scoped by construction.
     * Summing `totals` here would print a lifetime figure under a month
     * heading, which is the one arithmetic mistake this feature exists to
     * prevent.
     * @param entry - one tracked key from the payload.
     * @param periodKey - the payload's month key, e.g. `2026-09`.
     * @returns the month total, or `undefined` when neither source is usable.
     */
    function monthTotalOf(entry, periodKey) {
      if (typeof entry?.month === 'number' && Number.isFinite(entry.month)) return entry.month;
      const days = entry?.days;
      if (days === null || typeof days !== 'object') return undefined;
      let total;
      for (const [day, buckets] of Object.entries(days)) {
        if (typeof periodKey === 'string' && periodKey.length > 0 && !day.startsWith(`${periodKey}-`)) continue;
        const value = sumBuckets(buckets);
        if (value === undefined) continue;
        total = (total ?? 0) + value;
      }
      return total;
    }

    /**
     * The tracked-key block: each key, the machines reporting it, its models.
     *
     * Every figure here is already a total the host computed; this renders
     * them and nests them, so a key's own number can never be confused with a
     * machine's contribution to it.
     * @param tr - the translator.
     * @param tracked - the payload's `tracked` section, possibly absent.
     * @param periodKey - the payload's month key, for the fallback total.
     * @returns the rows, empty when no key is tracked.
     */
    function trackedRows(tr, tracked, periodKey) {
      const all = Array.isArray(tracked?.keys) ? tracked.keys : [];
      // `trackedHere === false` marks a key a peer reported to this aggregator:
      // real usage, but not this machine's credential. It is listed below,
      // apart and labelled, rather than dropped — a number that exists must not
      // silently vanish — and it is never added to "my keys".
      const keys = all.filter((entry) => entry?.trackedHere !== false);
      const peers = all.filter((entry) => entry?.trackedHere === false);
      if (keys.length === 0 && peers.length === 0) return [];
      const rows = [];
      if (keys.length > 0) rows.push(h(Caption, { key: 'cap-tracked' }, tr('panel.group.tracked')));
      for (const [index, entry] of keys.entries()) {
        const total = monthTotalOf(entry, periodKey);
        const providers = Array.isArray(entry?.providers) ? entry.providers : [];
        rows.push(h(Item, {
          key: `key-${index}`,
          label: tr('panel.key.label', { short: entry?.short ?? '—', ref: entry?.ref ?? '—' }),
          tokens: total,
          text: total === undefined ? '—' : undefined,
          strong: true,
          hint: [
            entry?.month,
            providers.length === 0 ? undefined : tr('panel.key.routes', { count: providers.length }),
          ].filter((part) => part !== undefined).join(' · '),
        }));
        // The all-time figure rides directly under the month one and says so:
        // two periods in one block is fine, two periods silently interchanged
        // is not.
        const allTime = sumBuckets(entry?.totals);
        if (allTime !== undefined) {
          rows.push(h('div', { className: 'dsh-month-tokens-subrows', key: `alltime-${index}` }, h(Item, {
            key: `alltime-item-${index}`,
            label: tr('panel.key.allTime'),
            tokens: allTime,
          })));
        }
        const instances = Array.isArray(entry?.instances) ? entry.instances : [];
        if (instances.length > 0) {
          rows.push(h(
            'div',
            { className: 'dsh-month-tokens-subrows', key: `instances-${index}` },
            instances.map((instance, position) => {
              const name = String(instance?.label ?? instance?.instance ?? '—');
              const age = ageText(tr, instance?.ageMs);
              const stale = instance?.stale === true;
              const described = age === undefined ? name : tr('panel.instance.label', { label: name, age });
              return h(Item, {
                key: `instance-${index}-${position}`,
                // A stale peer keeps its number and gains a word: the figure is
                // the last one that machine reported, and hiding it would read
                // as a machine that never existed.
                label: stale ? `${described} · ${tr('panel.instance.stale')}` : described,
                tokens: instance?.total,
                text: instance?.total === undefined ? '—' : undefined,
                stale,
                hint: [
                  instance?.month,
                  instance?.seq === undefined ? undefined : `#${instance.seq}`,
                ].filter((part) => part !== undefined).join(' · '),
              });
            }),
          ));
        }
        const models = Object.entries(entry?.models ?? {})
          .map(([name, buckets]) => ({ name, total: sumBuckets(buckets) }))
          .sort((left, right) => (right.total ?? 0) - (left.total ?? 0));
        if (models.length > 0) {
          rows.push(h(
            'div',
            { className: 'dsh-month-tokens-subrows', key: `models-${index}` },
            [
              h(Caption, { key: 'cap-models' }, tr('panel.group.models')),
              ...models.map((model, position) => h(Item, {
                key: `model-${index}-${position}`,
                label: model.name,
                tokens: model.total,
                text: model.total === undefined ? '—' : undefined,
              })),
            ],
          ));
        }
      }
      if (peers.length > 0) {
        rows.push(h(Caption, { key: 'cap-peers' }, tr('panel.group.peerKeys')));
        for (const [index, entry] of peers.entries()) {
          const total = monthTotalOf(entry, periodKey);
          rows.push(h(Item, {
            key: `peer-${index}`,
            label: tr('panel.key.label', { short: entry?.short ?? '—', ref: entry?.ref ?? '—' }),
            tokens: total,
            text: total === undefined ? '—' : undefined,
            hint: entry?.month,
          }));
        }
      }
      return rows;
    }

    /** The sidebar footer action: a badge plus its click-open breakdown panel. */
    function LedgerAction({ wide, t }) {
      const tr = typeof t === 'function' ? t : fallback;
      const [ledger, setLedger] = react.useState(null);
      const [live, setLive] = react.useState(false);
      const [open, setOpen] = react.useState(false);
      const [anchor, setAnchor] = react.useState(undefined);
      const rootRef = react.useRef(null);

      react.useEffect(() => {
        let source;
        try {
          source = new EventSource(STREAM_URL);
        } catch {
          return undefined;
        }
        const onLedger = (event) => {
          try {
            setLedger(JSON.parse(event.data));
            setLive(true);
          } catch {
            // A malformed frame leaves the last good value on screen.
          }
        };
        const onOpen = () => {
          setLive(true);
        };
        const onError = () => {
          setLive(false);
        };
        source.addEventListener('ledger', onLedger);
        source.addEventListener('open', onOpen);
        source.addEventListener('error', onError);
        return () => {
          source.close();
        };
      }, []);

      react.useLayoutEffect(() => {
        if (!open) {
          setAnchor(undefined);
          return undefined;
        }
        const place = () => {
          const rect = rootRef.current?.getBoundingClientRect();
          if (rect === undefined || rect === null) return;
          setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 });
        };
        place();
        window.addEventListener('resize', place);
        return () => {
          window.removeEventListener('resize', place);
        };
      }, [open]);

      react.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const target = event.target;
          if (rootRef.current !== null && target instanceof Node && rootRef.current.contains(target)) return;
          if (target instanceof Element && target.closest('[data-token-ledger-panel]') !== null) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown);
        };
      }, [open]);

      const buckets = ledger?.totals;
      const month = ledger?.month;
      // The tracked section is optional in both directions: an older host does
      // not send it, and a host whose owner configured no `trackKeys` sends it
      // with an empty list. Either way the row must fall back to exactly the
      // behaviour it had before this section existed — never a blank or a zero.
      const tracked = ledger?.tracked;
      // Only keys configured here may reach the headline. An aggregator's key
      // list also carries keys *peers* reported, and summing those under a
      // label that says "my key" answers a different question than the one it
      // asks. `trackedHere` absent means local, so an older host is unaffected.
      const trackedKeys = (Array.isArray(tracked?.keys) ? tracked.keys : []).filter((entry) => entry?.trackedHere !== false);
      const trackedActive = trackedKeys.length > 0;
      const periodKey = ledger?.period?.key;
      const headline = trackedActive
        ? trackedKeys.reduce((sum, entry) => sum + (monthTotalOf(entry, periodKey) ?? 0), 0)
        : month;
      const localMonth = ledger?.local?.month;
      const opencode = ledger?.tools?.opencode;
      const opencodeOk = opencode?.state === 'ok';
      const exact = ledger?.local?.exact;
      const monthSource = ledger?.local?.monthSource;
      const unattributed = ledger?.local?.unattributed ?? 0;
      const counted = ledger?.sessions?.counted ?? 0;
      const liveCount = ledger?.sessions?.live ?? 0;
      const skipped = ledger?.sessions?.skippedSeeded ?? 0;

      const badge = h(
        'button',
        {
          type: 'button',
          className: 'dsh-month-tokens-badge',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: tr(trackedActive ? 'panel.title.tracked' : 'panel.title'),
          ...(open ? { 'data-active': '' } : {}),
          onClick: () => {
            setOpen(!open);
          },
        },
        h('span', { className: 'dsh-month-tokens-glyph' }, h(LedgerGlyph)),
        wide ? h('span', { className: 'dsh-month-tokens-label' }, tr(trackedActive ? 'row.title.tracked' : 'row.title')) : null,
        h(
          'span',
          { className: 'dsh-month-tokens-count' },
          headline === undefined ? tr('row.pending') : tr('row.value', { count: formatTokens(headline) }),
        ),
      );

      const notes = [];
      // The coverage declaration is a standing fact about the number above it,
      // so it is a visible line rather than a hover title, and it survives a
      // scroll of the body (it lives outside the scrolling region).
      if (tracked !== undefined && tracked !== null) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-coverage': '', key: 'coverage' }, tr('panel.coverage')));
      }
      const uncovered = Array.isArray(tracked?.uncovered)
        ? tracked.uncovered.filter((name) => typeof name === 'string' && name.length > 0)
        : [];
      if (uncovered.length > 0) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'uncovered' }, tr('panel.note.uncovered', { count: uncovered.length, list: uncovered.join('、') })));
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'uncovered-hint' }, tr('panel.note.uncovered.hint')));
      }
      const failures = Array.isArray(tracked?.failures) ? tracked.failures : [];
      for (const [position, failure] of failures.entries()) {
        const reason = String(failure?.reason ?? '');
        const known = ['missing', 'empty', 'illegalCharacters', 'resolveFailed', 'invalidPattern'];
        const key = known.includes(reason) ? `panel.note.failure.${reason}` : 'panel.note.failure.other';
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: `failure-${position}` }, tr(key, {
          ref: String(failure?.ref ?? '—'),
          reason,
          detail: String(failure?.detail ?? '—'),
        })));
      }
      for (const [kind, section] of [['collector', tracked?.collector], ['reporter', tracked?.reporter]]) {
        if (section === null || typeof section !== 'object') continue;
        const verdict = linkStateKey(kind, section.state);
        if (verdict === undefined) continue;
        notes.push(h('div', {
          className: 'dsh-month-tokens-note',
          ...(verdict.warn ? { 'data-warn': '' } : {}),
          key: kind,
        }, tr(verdict.key, {
          state: String(section.state ?? '—'),
          host: String(section.host ?? '127.0.0.1'),
          port: String(section.port ?? '—'),
          url: String(section.url ?? '—'),
          count: section.instances ?? 0,
          age: ageText(tr, section.lastAt === undefined ? undefined : Date.now() - section.lastAt) ?? tr('panel.age.now'),
        })));
      }
      notes.push(h('div', { className: 'dsh-month-tokens-note', key: 'month' }, tr('panel.note.month')));
      if (unattributed > 0) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'split' }, tr('panel.note.split', { count: unattributed })));
      } else if (exact === true) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', key: 'exact' }, tr(monthSource === 'ledger' ? 'panel.note.ledger' : 'panel.note.exact')));
      }
      if (opencodeOk) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', key: 'oc-ok' }, tr('panel.note.opencode')));
      } else if (opencode !== undefined && opencode.state !== 'loading') {
        const key = `panel.note.opencode.${opencode.state === 'absent' ? 'absent' : opencode.state === 'drift' ? 'drift' : opencode.state === 'unavailable' ? 'unavailable' : 'error'}`;
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'oc' }, tr(key, { message: opencode.message ?? '' })));
      }
      if (skipped > 0) notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'skipped' }, tr('panel.skipped', { count: skipped })));
      if (live === false && ledger !== null) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'stale' }, tr('panel.stale')));
      }

      const rows = [];
      // The tracked block stands on its own: it is derived from the session
      // logs, not from the cumulative `totals`, so a payload that somehow
      // lacks the latter still shows what this key consumed.
      rows.push(...trackedRows(tr, tracked, periodKey));
      if (buckets === undefined) {
        rows.push(h('div', { className: 'dsh-month-tokens-itemLabel', key: 'empty' }, tr('panel.empty')));
      } else {
        rows.push(h(Caption, { key: 'cap-month' }, tr('panel.group.month')));
        rows.push(h(Item, { key: 'dsh', label: tr('panel.localMonth'), tokens: localMonth }));
        if (opencodeOk) {
          // The message count rides the hover title: it explains a lagging
          // figure far better than it earns a row of its own.
          rows.push(h(Item, { key: 'opencode', label: tr('panel.opencode'), tokens: sumBuckets(opencode.totals), hint: tr('panel.opencodeMessages', { count: opencode.messages ?? 0 }) }));
        }
        rows.push(h('div', { className: 'dsh-month-tokens-rule', key: 'rule1' }));
        rows.push(h(Caption, { key: 'cap-history' }, tr('panel.group.history')));
        rows.push(h(Item, { key: 'total', label: tr('panel.historyTotal'), tokens: ledger?.local?.total, strong: true }));
        rows.push(h(Item, { key: 'in', label: tr('panel.uncachedInput'), tokens: buckets.uncachedInputTokens }));
        rows.push(h(Item, { key: 'cr', label: tr('panel.cacheRead'), tokens: buckets.cacheReadTokens }));
        rows.push(h(Item, { key: 'cw', label: tr('panel.cacheWrite'), tokens: buckets.cacheWriteTokens }));
        rows.push(h(Item, { key: 'out', label: tr('panel.output'), tokens: buckets.outputTokens }));
        rows.push(h(Item, { key: 'sessions', label: tr('panel.sessions'), text: tr('panel.sessions.value', { counted, live: liveCount }) }));
      }

      const panel =
        open && anchor !== undefined
          ? reactDom.createPortal(
              h(
                'div',
                {
                  className: 'dsh-month-tokens-panel',
                  'data-token-ledger-panel': '',
                  role: 'dialog',
                  'aria-label': tr(trackedActive ? 'panel.title.tracked' : 'panel.title'),
                  style: { left: anchor.left, bottom: anchor.bottom },
                },
                h(
                  'div',
                  { className: 'dsh-month-tokens-head' },
                  h('span', { className: 'dsh-month-tokens-grand' }, headline === undefined ? '—' : formatTokens(headline)),
                  h('span', { className: 'dsh-month-tokens-grandSub' }, tr(trackedActive ? 'panel.title.tracked' : 'panel.title')),
                  h('span', { className: 'dsh-month-tokens-sub' }, tr(trackedActive ? 'panel.subtitle.tracked' : opencodeOk ? 'panel.subtitle.tools' : 'panel.subtitle.dsh', { period: ledger?.period?.key ?? '—' })),
                ),
                h('div', { className: 'dsh-month-tokens-rule' }),
                h('div', { className: 'dsh-month-tokens-body' }, rows),
                notes.length === 0 ? null : h('div', { className: 'dsh-month-tokens-rule' }),
                notes,
              ),
              document.body,
            )
          : null;

      return h(
        'div',
        { className: 'dsh-month-tokens-layer', ref: rootRef, ...(wide ? {} : { 'data-rail': '' }) },
        badge,
        panel,
      );
    }

    /** Required client services: the slot registry and the dictionary seat. */
    const inject = ['slots', 'locale'];

    /**
     * Client plugin body: one sidebar footer action, directly above Settings.
     * @param ctx - client root context.
     */
    function apply(ctx) {
      ensureStyles();
      ctx.effect(
        () =>
          ctx.locale.register(NS, {
            zh,
            en,
          }),
        'token-ledger: dictionaries',
      );
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register(
          {
            name: 'sidebar.footer.action',
            id: 'token-ledger',
            order: 10,
            // No `label`: every shipped `label` is a resolver function, this
            // slot's own shipped registrant omits it, and the occupant owns
            // its accessible name through the button's `title`/`aria-label`.
            locale: NS,
          },
          LedgerAction,
        ),
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.LedgerAction = LedgerAction;
    return module.exports;
  },
});
