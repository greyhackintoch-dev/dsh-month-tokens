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
      'panel.subtitle.tools': '本机 DSH + {tools} · {period} 起',
      'panel.subtitle.tracked': '按 key 归集 · {period} 起',
      'panel.group.month': '本月消耗',
      'panel.group.tracked': '我的 key（跨机归集）',
      'panel.group.peerKeys': '对端上报的其他 key（不计入上方）',
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
      'panel.localMonth': '本机 DSH',
      'panel.opencode': 'opencode',
      'panel.pen': 'Pen',
      'panel.workbuddy': 'WorkBuddy',
      // One key for all three readers: the hint explains a lagging figure, and
      // the lag is the same fact whichever tool wrote the row.
      'panel.toolRecords': '{count} 条记录',
      'panel.sessions': '计入会话',
      'panel.sessions.value': '{counted} 个（{live} 个在运行）',
      'panel.stale': '与主机连接中断，显示的是最后一次同步的值。',
      'panel.empty': '还没有任何提供商上报的用量。',
      'panel.note.split': '有 {count} 个会话创建于本月之前、本月又用过，累计值无法拆分月份归属，未计入本月。',
      'panel.spark.label': '最近 {count} 天',
      'panel.spark.aria': '{first} 至 {last}，共 {count} 天的每日消耗',
      'panel.spark.day': '{day} · {tokens}',
      'panel.note.opencode.absent': '未找到 opencode 数据库，其用量未计入。',
      'panel.note.opencode.drift': 'opencode 数据库结构已变化，读不出 token，其用量未计入。',
      'panel.note.opencode.unavailable': '当前运行时没有 node:sqlite，无法读取 opencode 用量。',
      'panel.note.opencode.error': 'opencode 用量读取失败：{message}',
      'panel.note.tool.absent': '未找到 {tool} 的本月记录，其用量未计入。',
      'panel.note.tool.drift': '{tool} 的记录结构已变化，读不出 token，其用量未计入。',
      'panel.note.tool.unreadable': '{tool} 的凭证文件读不了，无法判断它在不在用这把 key。',
      'panel.note.tool.error': '{tool} 用量读取失败：{message}',
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
      'panel.subtitle.tools': 'This DSH home + {tools} · since {period}',
      'panel.subtitle.tracked': 'Gathered by key · since {period}',
      'panel.group.month': 'This month',
      'panel.group.tracked': 'My keys (gathered across machines)',
      'panel.group.peerKeys': 'Other keys reported by peers (not counted above)',
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
      'panel.localMonth': 'This DSH home',
      'panel.opencode': 'opencode',
      'panel.pen': 'Pen',
      'panel.workbuddy': 'WorkBuddy',
      'panel.toolRecords': '{count} records',
      'panel.sessions': 'Sessions counted',
      'panel.sessions.value': '{counted} ({live} live)',
      'panel.stale': 'Disconnected from the host; showing the last synced value.',
      'panel.empty': 'No provider-reported usage yet.',
      'panel.note.split': '{count} session(s) were created before this month and used in it; a cumulative total cannot be split across the boundary, so they are not counted.',
      'panel.spark.label': 'Last {count} days',
      'panel.spark.aria': 'Daily usage from {first} to {last}, {count} days',
      'panel.spark.day': '{day} · {tokens}',
      'panel.note.opencode.absent': 'No opencode database was found; its usage is not counted.',
      'panel.note.opencode.drift': 'The opencode database schema has changed and no tokens could be read; its usage is not counted.',
      'panel.note.opencode.unavailable': 'This runtime has no node:sqlite, so opencode usage cannot be read.',
      'panel.note.opencode.error': 'Reading opencode usage failed: {message}',
      'panel.note.tool.absent': 'No {tool} record was found for this month; its usage is not counted.',
      'panel.note.tool.drift': 'The {tool} record schema has changed and no tokens could be read; its usage is not counted.',
      'panel.note.tool.unreadable': 'The {tool} credential file could not be read, so it cannot be told apart from another key.',
      'panel.note.tool.error': 'Reading {tool} usage failed: {message}',
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
      // Rail (collapsed sidebar): the row keeps the *same* box and left inset
      // the expanded row uses, and only the badge shrinks. Sizing the layer to
      // the badge instead — a fixed 36px box at margin 0 — moved the glyph left
      // of every neighbouring action in the rail, because the inset the sidebar
      // gives its own icons lives in that padding, not in the row's box.
      // Rail (collapsed sidebar). Read off the sidebar's own CSS rather than
      // approximated: in the rail it gives each footer action
      // `justify-content:center; width:auto; display:flex` and lets
      // `footArea{align-items:center}` do the horizontal centring, while its
      // `iconButton` becomes a 36px circle — which is what this badge already
      // is. Matching the *rule* instead of measuring a pixel offset is what
      // makes this land on the same axis as the gear by construction; sizing
      // the row to a fixed box, or insetting it by hand, both miss it.
      '.dsh-month-tokens-layer[data-rail]{display:flex;width:auto;height:36px;margin:0;padding:0;justify-content:center}',
      '.dsh-month-tokens-layer[data-rail] .dsh-month-tokens-badge{corner-shape:round;border-radius:50%;justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0}',
      '.dsh-month-tokens-layer[data-rail] .dsh-month-tokens-count{display:none}',
      '.dsh-month-tokens-layer[data-rail] .dsh-month-tokens-label{display:none}',
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
      // The 7-day shape. It sits under the key's own figures and above the
      // machines that fed them: "how much" and "where from" first, "how it
      // went" as the reading aid between them.
      // Rendered outside the indented row wrapper and without horizontal
      // padding: the chart is the one full-bleed element, so its viewBox width
      // IS the content width and nothing is scaled to fit.
      '.dsh-month-tokens-spark{padding:7px 0 3px 0;flex-direction:column;gap:3px;display:flex}',
      '.dsh-month-tokens-sparkTick{fill:var(--dsw-alias-label-tertiary);font-size:9px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-sparkHead{align-items:baseline;gap:8px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:15px;display:flex}',
      '.dsh-month-tokens-sparkRange{color:var(--dsw-alias-label-tertiary);margin-left:auto;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-sparkSvg{display:block}',
      // `preserveAspectRatio` is left alone on purpose: the viewBox is already
      // the panel's content width, so uniform scaling keeps the dot round and
      // the hairline a hairline instead of stretching both.
      '.dsh-month-tokens-sparkLine{fill:none;stroke:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}',
      '.dsh-month-tokens-sparkArea{fill:var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));stroke:none;opacity:.12}',
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
     * The last `count` calendar days of a key's month, oldest first.
     *
     * A calendar axis, not a list of the days that happen to have records.
     * `days` is month-scoped by contract (§4.3) and the fold visits every day
     * of the month, so *inside* the month an absent key is a real zero and is
     * drawn as one. Reading only the present keys instead would silently drop
     * the gaps and space the axis by "days that were used" — the preview that
     * prompted this drew 9/16–9/24 as seven points across nine days.
     *
     * Before the month start the reasoning inverts: the fold never looked
     * there, so those days are *unknown* and are left out rather than zeroed.
     * That is why a window early in a month comes back short, and why the
     * caller labels the range it actually drew.
     * @param entry - one tracked-key entry.
     * @param count - how many calendar days to keep.
     * @returns `{ day, tokens }` oldest-first.
     */
    function recentSeries(entry, count) {
      const days = entry?.days;
      if (days === null || typeof days !== 'object') return [];
      const keys = Object.keys(days)
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))
        .sort();
      if (keys.length === 0) return [];
      // The anchor is the last day with any record, so a quiet morning does not
      // push the window off today and onto a day that has not happened yet.
      const month = keys[keys.length - 1].slice(0, 7);
      const series = [];
      for (let back = count - 1; back >= 0; back -= 1) {
        const day = shiftDay(keys[keys.length - 1], -back);
        if (!day.startsWith(`${month}-`)) continue;
        series.push({ day, tokens: sumBuckets(days[day]) ?? 0 });
      }
      return series;
    }

    /**
     * One calendar day shifted by whole days, in local time.
     *
     * Built through `Date` rather than by adding 86,400,000 to a timestamp: the
     * arithmetic has to survive a month boundary and a DST shift, and only the
     * calendar knows about either.
     * @param day - a `YYYY-MM-DD` key.
     * @param delta - whole days to add (negative walks backwards).
     * @returns the shifted `YYYY-MM-DD` key.
     */
    function shiftDay(day, delta) {
      const [year, month, date] = day.split('-').map(Number);
      const at = new Date(year, month - 1, date + delta);
      const pad = (value) => String(value).padStart(2, '0');
      return `${String(at.getFullYear()).padStart(4, '0')}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
    }

    /**
     * `9/18–9/24`, or a single day when the range has one.
     * @param series - the points from {@link recentSeries}.
     * @returns the range label.
     */
    function rangeLabel(series) {
      const short = (day) => {
        const [, month, date] = day.split('-');
        return `${String(Number(month))}/${String(Number(date))}`;
      };
      const first = series[0];
      const last = series[series.length - 1];
      return first === last ? short(first.day) : `${short(first.day)}–${short(last.day)}`;
    }

    /**
     * One tick: the day of the month.
     *
     * No month, and not as a display preference — `days` is month-scoped by
     * contract (§4.3), the window is clamped to that month, so every tick on
     * this axis is necessarily in the same one. The range label above already
     * says which. A `M/D` form here would be unreachable code pretending to be
     * defensive.
     *
     * That invariant is what a future cross-month `recent` window (the shape
     * §4.4.1 names as the correct way to extend this) would break, and this is
     * the line that would have to change with it.
     * @param day - a `YYYY-MM-DD` key.
     * @returns the tick text.
     */
    function tickLabel(day) {
      return String(Number(day.slice(8, 10)));
    }

    /**
     * The 7-day shape, as one hand-drawn path.
     *
     * No chart library: the client bundle requires nothing but the platform
     * seed words, and a sparkline is a polyline. Each day also carries an
     * invisible column with its own `<title>`, so the exact figure is a hover
     * away without printing seven numbers under the line.
     *
     * Renders nothing below two points. On a calendar axis that means only the
     * 1st of a month, where the window has no earlier day inside it to draw —
     * a lone dot with an axis under it would say more than the data does.
     * @param props - the series and the translator.
     * @returns the chart element, or `null`.
     */
    function Sparkline({ series, tr }) {
      if (series.length < 2) return null;
      // The viewBox is the panel's own content width, so the chart renders 1:1
      // and nothing is stretched to fit; the caller renders it outside the
      // indented row wrapper precisely so those numbers still agree.
      const WIDTH = 288;
      const PLOT_H = 58;
      const LABEL_H = 15;
      const HEIGHT = PLOT_H + LABEL_H;
      // Wide enough for the first and last tick to sit centred under their own
      // points without overhanging the box — `9/30` is the binding case.
      const PAD_X = 13;
      const PAD_Y = 6;
      const peak = Math.max(...series.map((point) => point.tokens), 1);
      const step = (WIDTH - PAD_X * 2) / (series.length - 1);
      const coords = series.map((point, index) => [
        PAD_X + index * step,
        PLOT_H - PAD_Y - (point.tokens / peak) * (PLOT_H - PAD_Y * 2),
      ]);
      const line = coords
        .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
        .join(' ');
      const baseline = (PLOT_H - PAD_Y).toFixed(1);
      const area = `${line} L${coords[coords.length - 1][0].toFixed(1)} ${baseline} L${coords[0][0].toFixed(1)} ${baseline} Z`;
      const first = series[0].day;
      const last = series[series.length - 1].day;
      return h(
        'div',
        { className: 'dsh-month-tokens-spark' },
        h(
          'div',
          { className: 'dsh-month-tokens-sparkHead' },
          h('span', null, tr('panel.spark.label', { count: series.length })),
          h('span', { className: 'dsh-month-tokens-sparkRange' }, rangeLabel(series)),
        ),
        h(
          'svg',
          {
            className: 'dsh-month-tokens-sparkSvg',
            viewBox: `0 0 ${String(WIDTH)} ${String(HEIGHT)}`,
            width: '100%',
            height: HEIGHT,
            role: 'img',
            'aria-label': tr('panel.spark.aria', { first, last, count: series.length }),
          },
          h('path', { className: 'dsh-month-tokens-sparkArea', d: area }),
          h('path', { className: 'dsh-month-tokens-sparkLine', d: line, vectorEffect: 'non-scaling-stroke' }),
          series.map((point, index) =>
            h(
              'text',
              {
                key: `tick-${point.day}`,
                'data-tick': point.day,
                className: 'dsh-month-tokens-sparkTick',
                x: coords[index][0].toFixed(1),
                y: PLOT_H + 11,
                textAnchor: 'middle',
              },
              tickLabel(point.day),
            ),
          ),
          series.map((point, index) =>
            h(
              'rect',
              {
                key: point.day,
                // Named so the day is inspectable rather than inferred from
                // geometry — the hover target and the test ask the same thing.
                'data-day': point.day,
                x: coords[index][0] - step / 2,
                y: 0,
                width: step,
                height: PLOT_H,
                fill: 'transparent',
              },
              h('title', null, tr('panel.spark.day', { day: point.day, tokens: formatTokens(point.tokens) })),
            ),
          ),
        ),
      );
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
        // The 7-day shape rides with the key's own figures, above the machine
        // rows: the chart is about this key, and the instances below it are a
        // different axis (who fed it, not how it went).
        const series = recentSeries(entry, 7);
        if (series.length >= 2) {
          rows.push(h(Sparkline, { series, tr, key: `spark-${index}` }));
        }
        // The per-model split is deliberately not rendered: the panel answers
        // "how much, and where from", and a model breakdown under a key total
        // is a third question nobody asked. The host still computes it, so a
        // future surface can show it without a payload change.
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
      // The three third-party readers share one contract — `{state, totals,
      // messages}` — so they render through one pair of helpers rather than
      // three copies of the same row and the same note.
      const tools = [
        { id: 'opencode', label: 'opencode', tool: opencode },
        { id: 'pen', label: 'Pen', tool: ledger?.tools?.pen },
        { id: 'workbuddy', label: 'WorkBuddy', tool: ledger?.tools?.workbuddy },
      ];
      const liveTools = tools.filter((entry) => entry.tool?.state === 'ok');
      const exact = ledger?.local?.exact;
      const monthSource = ledger?.local?.monthSource;
      const unattributed = ledger?.local?.unattributed ?? 0;
      const counted = ledger?.sessions?.counted ?? 0;
      const liveCount = ledger?.sessions?.live ?? 0;

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

      // Only the notes that report an *exclusion* survive. Everything else that
      // used to live here — the coverage declaration, the link states, the
      // period, the period-provenance lines — was standing prose beside a
      // number, and the panel is read for the number. These two are different
      // in kind: they fire only when something is being left out, and a silent
      // under-count is the one failure this ledger exists to prevent.
      const notes = [];
      const uncovered = Array.isArray(tracked?.uncovered)
        ? tracked.uncovered.filter((name) => typeof name === 'string' && name.length > 0)
        : [];
      if (uncovered.length > 0) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'uncovered' }, tr('panel.note.uncovered', { count: uncovered.length, list: uncovered.join('、') })));
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'uncovered-hint' }, tr('panel.note.uncovered.hint')));
      }
      const failures = Array.isArray(tracked?.failures) ? tracked.failures : [];
      // An opencode read that failed is an exclusion too: its share is missing
      // from the number above, and silence would read as "it spent nothing".
      for (const entry of tools) {
        const tool = entry.tool;
        if (tool === undefined || tool.state === 'ok' || tool.state === 'loading') continue;
        // opencode keeps its own, more specific sentences (they name the
        // database and the missing `node:sqlite`); the other two share a set
        // that names the tool instead.
        const key = entry.id === 'opencode'
          ? `panel.note.opencode.${tool.state === 'absent' ? 'absent' : tool.state === 'drift' ? 'drift' : tool.state === 'unavailable' ? 'unavailable' : 'error'}`
          : `panel.note.tool.${tool.state === 'absent' ? 'absent' : tool.state === 'drift' ? 'drift' : tool.state === 'unreadable' ? 'unreadable' : 'error'}`;
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: `tool-${entry.id}` }, tr(key, {
          tool: entry.label,
          message: tool.message ?? '',
        })));
      }
      // A session whose month cannot be split is left out of the month figure,
      // and a forked session is left out of the machine figure. Both say so.
      if (unattributed > 0) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'split' }, tr('panel.note.split', { count: unattributed })));
      }
      if (live === false && ledger !== null) {
        notes.push(h('div', { className: 'dsh-month-tokens-note', 'data-warn': '', key: 'stale' }, tr('panel.stale')));
      }
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
        for (const entry of liveTools) {
          // A reader that has no record this month simply has no row: the
          // group answers "where did it go", and a platform that spent nothing
          // is not part of that answer.
          rows.push(h(Item, {
            key: entry.id,
            label: tr(`panel.${entry.id}`),
            tokens: sumBuckets(entry.tool.totals),
            // The record count rides the hover title: it explains a lagging
            // figure far better than it earns a row of its own.
            hint: tr('panel.toolRecords', { count: entry.tool.messages ?? 0 }),
          }));
        }
        // The machine's all-time bucket breakdown is not rendered either. It
        // answered a question this panel no longer asks — the key's own
        // all-time figure sits with the key, above.
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
                  // No restatement of the label under the number: the row it
                  // opened from already says what this is, and the badge
                  // carries the same words as its hover title.
                  h('span', { className: 'dsh-month-tokens-sub' }, tr(trackedActive ? 'panel.subtitle.tracked' : liveTools.length > 0 ? 'panel.subtitle.tools' : 'panel.subtitle.dsh', {
                    period: ledger?.period?.key ?? '—',
                    tools: liveTools.map((entry) => entry.label).join(' + '),
                  })),
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
