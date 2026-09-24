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
      'row.value': '{count}',
      'row.pending': '统计中',
      'panel.title': '本月消耗 Token',
      'panel.subtitle.dsh': '仅本机 DSH · {period} 起',
      'panel.subtitle.tools': '本机 DSH + opencode · {period} 起',
      'panel.group.month': '本月消耗',
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
      'row.value': '{count}',
      'row.pending': 'Measuring',
      'panel.title': 'Token usage this month',
      'panel.subtitle.dsh': 'This DSH home only · since {period}',
      'panel.subtitle.tools': 'This DSH home + opencode · since {period}',
      'panel.group.month': 'This month',
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
      '.dsh-month-tokens-panel{z-index:40;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));width:312px;max-width:calc(100vw - 24px);box-shadow:var(--dsw-elevation-prominent,var(--dsw-shadow-lv3));border:1px solid var(--dsw-alias-border-l1);border-radius:12px;flex-direction:column;display:flex;position:fixed;overflow:hidden}',
      '.dsh-month-tokens-head{box-sizing:border-box;flex-direction:column;gap:2px;padding:12px 12px 10px;display:flex}',
      '.dsh-month-tokens-grand{color:var(--dsw-alias-label-primary);font-size:26px;font-weight:600;line-height:32px;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-grandSub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:15px;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-sub{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}',
      '.dsh-month-tokens-rule{height:1px;background:var(--dsw-alias-border-l2);flex:none}',
      '.dsh-month-tokens-body{flex-direction:column;gap:0;padding:6px 12px 10px;display:flex}',
      '.dsh-month-tokens-caption{color:var(--dsw-alias-label-caption);letter-spacing:.04em;padding:6px 0 2px;font-size:11px;font-weight:500;line-height:16px}',
      '.dsh-month-tokens-item{align-items:baseline;gap:12px;padding:4px 0;display:flex}',
      '.dsh-month-tokens-itemLabel{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:18px;flex:1;min-width:0}',
      '.dsh-month-tokens-itemValue{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;font-variant-numeric:tabular-nums;font-family:var(--ds-font-family-code,ui-monospace,monospace)}',
      '.dsh-month-tokens-item[data-strong] .dsh-month-tokens-itemLabel{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.dsh-month-tokens-note{color:var(--dsw-alias-label-tertiary);padding:6px 12px 0;font-size:11px;line-height:16px}',
      '.dsh-month-tokens-note[data-warn]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}',
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
     * @param props - label, a raw token count or pre-formatted text, and emphasis.
     * @returns the row element.
     */
    function Item({ label, tokens, text, strong, hint }) {
      const value = tokens === undefined ? text : formatTokens(tokens);
      const title = [tokens === undefined ? undefined : formatExact(tokens), hint].filter((part) => part !== undefined).join(' · ');
      return h(
        'div',
        { className: 'dsh-month-tokens-item', ...(strong === true ? { 'data-strong': '' } : {}) },
        h('span', { className: 'dsh-month-tokens-itemLabel' }, label),
        h('span', { className: 'dsh-month-tokens-itemValue', ...(title === '' ? {} : { title }) }, value),
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
          title: tr('panel.title'),
          ...(open ? { 'data-active': '' } : {}),
          onClick: () => {
            setOpen(!open);
          },
        },
        h('span', { className: 'dsh-month-tokens-glyph' }, h(LedgerGlyph)),
        wide ? h('span', { className: 'dsh-month-tokens-label' }, tr('row.title')) : null,
        h(
          'span',
          { className: 'dsh-month-tokens-count' },
          month === undefined ? tr('row.pending') : tr('row.value', { count: formatTokens(month) }),
        ),
      );

      const notes = [h('div', { className: 'dsh-month-tokens-note', key: 'month' }, tr('panel.note.month'))];
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
                  'aria-label': tr('panel.title'),
                  style: { left: anchor.left, bottom: anchor.bottom },
                },
                h(
                  'div',
                  { className: 'dsh-month-tokens-head' },
                  h('span', { className: 'dsh-month-tokens-grand' }, month === undefined ? '—' : formatTokens(month)),
                  h('span', { className: 'dsh-month-tokens-grandSub' }, tr('panel.title')),
                  h('span', { className: 'dsh-month-tokens-sub' }, tr(opencodeOk ? 'panel.subtitle.tools' : 'panel.subtitle.dsh', { period: ledger?.period?.key ?? '—' })),
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
