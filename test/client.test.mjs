/**
 * Browser-half checks for dsh-month-tokens.
 *
 * Loads the real client bundle through a stand-in for the DSH client module
 * loader, renders the registered component with a minimal React stand-in, and
 * checks the packaging contract the host-side scanner relies on.
 *
 * Usage: node test/client.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// ------------------------------------------------------------ packaging
{
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'dsh-month-tokens', 'the bundle id and the package name must agree');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.dsh.client.platform, 'web', 'client-modules ignores a non-web platform');
  assert.ok(Array.isArray(pkg.dsh.client.inject));
  const clientRel = pkg.exports['./client'];
  assert.equal(typeof clientRel, 'string', 'the scanner reads exports["./client"] as a string or {default}');
  assert.ok(existsSync(join(root, clientRel)), `exports["./client"] must exist: ${clientRel}`);
  assert.ok(existsSync(join(root, pkg.exports['.'])), 'the host entry must exist');
  assert.ok(existsSync(join(root, pkg.dsh.bundle.patch)), 'the bundle patch must exist');
  // The host entry is what the loader imports for an absolute-path insert.
  assert.match(pkg.exports['.'], /^\.\/lib\/index\.js$/, 'the host entry must be a filesystem path the scanner can walk up from');
}

// -------------------------------------------------- minimal React stand-in
/** State values the next render's useState calls consume, in call order. */
let stateQueue = [];

const react = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    const merged = { ...(props ?? {}) };
    if (children.length === 1) merged.children = children[0];
    else if (children.length > 1) merged.children = children;
    return { type, props: merged };
  },
  useState(initial) {
    const next = stateQueue.length > 0 ? stateQueue.shift() : initial;
    return [typeof next === 'function' ? next() : next, () => {}];
  },
  useRef(initial) {
    return { current: initial };
  },
  useEffect() {},
  useLayoutEffect() {},
};

const reactDom = {
  createPortal(node) {
    return node;
  },
};

/** Collapse an element tree into its text, invoking function components. */
function render(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(render).join('');
  const { type, props } = node;
  if (typeof type === 'function') return render(type(props ?? {}));
  return render(props?.children);
}

/** Collect every className in an element tree. */
function classNames(node, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) classNames(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    classNames(node.type(node.props ?? {}), out);
    return out;
  }
  if (typeof node.props?.className === 'string') out.push(node.props.className);
  classNames(node.props?.children, out);
  return out;
}

// ------------------------------------------------------- loader stand-in
/** Style tags the bundle injected. */
const styleTags = [];
const document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: {
    append(tag) {
      styleTags.push(tag);
    },
  },
  body: {},
  addEventListener() {},
  removeEventListener() {},
};

let loaded = null;
const window = {
  __ModuleLoader__: {
    load(entry) {
      loaded = entry;
    },
  },
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
};

// The bundle is a classic script that registers itself on window.
const source = readFileSync(join(root, 'client/client.js'), 'utf8');
new Function('window', 'document', 'EventSource', source)(window, document, function EventSource() {});

assert.ok(loaded !== null, 'the bundle must register itself with window.__ModuleLoader__');
assert.equal(loaded.id, 'dsh-month-tokens', 'the registered id must equal the package name');
assert.equal(typeof loaded.factory, 'function');

const requireShim = (specifier) => {
  if (specifier === 'react') return react;
  if (specifier === 'react-dom') return reactDom;
  throw new Error(`unexpected require("${specifier}") — only platform seed words may be requested`);
};

const exports_ = loaded.factory(requireShim);
assert.equal(typeof exports_.apply, 'function', 'a client plugin exports apply');
assert.deepEqual(exports_.inject, ['slots', 'locale'], 'a client plugin exports its service inject list');

// ------------------------------------------------------------ apply()
const registrations = [];
const localeRegistrations = [];
const fakeCtx = {
  effect(body) {
    body();
    return () => {};
  },
  locale: {
    register(namespace, dictionaries) {
      localeRegistrations.push({ namespace, dictionaries });
      return () => {};
    },
  },
  slots: {
    inject(slotName, body) {
      assert.equal(slotName, 'sidebar.footer.action');
      body();
    },
    register(spec, component) {
      registrations.push({ spec, component });
      return () => {};
    },
  },
};

exports_.apply(fakeCtx);

assert.equal(styleTags.length, 1, 'exactly one stylesheet is injected');
assert.ok(styleTags[0].textContent.includes('dsh-month-tokens-panel'), 'the panel styles must ship');

// The glyph must take its colour from the badge, never declare one: a tint here
// is what made it read greyer than the Settings gear directly below it.
{
  const css = styleTags[0].textContent;
  const glyph = /\.dsh-month-tokens-glyph\{([^}]*)\}/.exec(css);
  assert.ok(glyph !== null, 'the glyph rule must exist');
  assert.ok(!glyph[1].includes('color'), `the glyph must not set its own colour, got: ${glyph[1]}`);
  const badge = /\.dsh-month-tokens-badge\{([^}]*)\}/.exec(css);
  assert.ok(badge[1].includes('color:var(--dsw-alias-label-primary)'), 'the badge supplies label-primary for both to inherit, like the Settings trigger');
}
assert.equal(localeRegistrations.length, 1);
assert.equal(localeRegistrations[0].namespace, 'tokenLedger');
assert.deepEqual(
  Object.keys(localeRegistrations[0].dictionaries.zh).sort(),
  Object.keys(localeRegistrations[0].dictionaries.en).sort(),
  'the en dictionary must cover exactly the zh key set',
);

assert.equal(registrations.length, 1, 'exactly one footer action is registered');
const { spec, component } = registrations[0];
assert.equal(spec.name, 'sidebar.footer.action', 'this is the seat directly above sidebar.settings');
assert.equal(spec.id, 'token-ledger');
assert.ok(Number.isFinite(spec.order), 'a list slot entry carries an order');
assert.equal(spec.locale, 'tokenLedger');
assert.deepEqual(
  Object.keys(spec).sort(),
  ['id', 'locale', 'name', 'order'],
  'the spec carries no field the slot core would have to interpret (every shipped `label` is a resolver function)',
);
assert.equal(typeof component, 'function');

// The dictionary must satisfy every key the component actually asks for.
const zh = localeRegistrations[0].dictionaries.zh;
const asked = [];
const t = (key, params) => {
  asked.push(key);
  const template = zh[key];
  assert.ok(template !== undefined, `the component asked for an undefined key: ${key}`);
  return params === undefined ? template : template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
};

/** Render the component at one state, returning the element tree. */
const treeAt = (ledger, { live = true, open = false, wide = true } = {}) => {
  stateQueue = [ledger, live, open, open ? { left: 12, bottom: 200 } : undefined];
  return component({ wide, t });
};

/** Render the component at one state and collapse it to its text. */
const at = (ledger, options) => render(treeAt(ledger, options));

// ---------------------------------------------------- closed (no data yet)
assert.ok(at(null).includes('本月消耗Token'), 'the row label names both the period and what it counts');
assert.ok(at(null).includes('统计中'), 'an unseeded ledger reads as pending, never as a hard zero');

const LOCAL = { uncachedInputTokens: 13600, outputTokens: 4519, cacheReadTokens: 144512, cacheWriteTokens: 0 };
const SESSIONS = { counted: 12, live: 1, skippedSeeded: 0, scannedAt: 0 };
const PERIOD = { kind: 'month', key: '2026-09', start: 0, end: 0 };
const OPENCODE_OK = { state: 'ok', totals: { uncachedInputTokens: 1_700_000, outputTokens: 77_000, cacheReadTokens: 13_000_000, cacheWriteTokens: 0 }, messages: 98, fetchedAt: 0 };
const ledgerAt = (local, tools = { opencode: { state: 'absent' } }) => ({
  revision: 9,
  period: PERIOD,
  totals: LOCAL,
  month: local.month + (tools.opencode?.state === 'ok' ? 14_777_000 : 0),
  local,
  tools,
  sessions: SESSIONS,
});
const EXACT = { total: 162631, month: 100000, monthSource: 'born', exact: true, unattributed: 0 };

// ---------------------------------------------------------- closed, loaded
assert.ok(at(ledgerAt(EXACT)).includes('本月消耗Token10万'), 'the row shows the month figure in 万 units');

// ------------------------------------------------------------ rail (narrow)
{
  const rail = classNames(treeAt(ledgerAt(EXACT), { wide: false }));
  assert.ok(rail.includes('dsh-month-tokens-layer'), 'the layer class must always be present');
  assert.ok(!rail.includes('dsh-month-tokens-dot'), 'the status dot is gone: it pushed the glyph out of line with Settings');
  assert.ok(!styleTags[0].textContent.includes('ledger-dot'), 'and its stylesheet rule is gone too');
}

// ---------------------------------------------------------- the open panel
{
  const text = at(ledgerAt(EXACT), { open: true });
  for (const fragment of [
    '本月消耗 Token',
    '仅本机 DSH · 2026-09 起',
    // Each assertion spans a caption or label and its value, so a right number
    // on the wrong row cannot pass.
    '本月消耗本机 DSH10万',
    '本机历史累计（仅 DSH）合计16.26万',
    '未缓存输入1.36万',
    '缓存命中14.45万',
    '缓存写入0',
    '输出4519',
    '计入会话12 个（1 个在运行）',
    '每月 1 日 00:00 自动归零',
    '按会话创建时间与最后提问时间逐会话判定',
  ]) {
    assert.ok(text.includes(fragment), `the open panel must show "${fragment}", got: ${text}`);
  }
  assert.ok(!text.includes('无法拆分月份归属'), 'an exact month carries no caveat');
  assert.ok(text.includes('未找到 opencode 数据库'), 'an absent opencode database is stated, not hidden');
  assert.ok(!text.includes('opencode\n'), 'and no opencode row is invented for it');
}

// -------------------------------------- opencode rows and the combined headline
{
  const text = at(ledgerAt(EXACT, { opencode: OPENCODE_OK }), { open: true });
  for (const fragment of [
    '本机 DSH + opencode · 2026-09 起',
    '本月消耗本机 DSH10万',
    'opencode1477.7万',
    '按消息完成落库，最多滞后约 1 分钟',
  ]) {
    assert.ok(text.includes(fragment), `the opencode panel must show "${fragment}", got: ${text}`);
  }
  assert.ok(!text.includes('未找到 opencode 数据库'), 'a working database carries no absence note');
  // The headline adds the two sources; the row above it must not double count.
  assert.ok(at(ledgerAt(EXACT, { opencode: OPENCODE_OK })).includes('本月消耗Token1487.7万'), 'the row shows DSH + opencode');
}

// ------------------------- each opencode failure mode gets its own sentence
{
  const cases = [
    ['drift', '数据库结构已变化'],
    ['unavailable', '没有 node:sqlite'],
    ['error', 'opencode 用量读取失败'],
  ];
  for (const [state, fragment] of cases) {
    const text = at(ledgerAt(EXACT, { opencode: { state, message: 'boom' } }), { open: true });
    assert.ok(text.includes(fragment), `state ${state} must say "${fragment}", got: ${text}`);
    assert.ok(text.includes('本机历史累计（仅 DSH）合计16.26万'), `state ${state} must not disturb the DSH figures`);
  }
}

// -------------------------------------- the day-ledger provenance note
{
  const text = at(ledgerAt({ ...EXACT, monthSource: 'ledger' }), { open: true });
  assert.ok(text.includes('按日历日精确汇总'), 'the ledger path says what it is');
  assert.ok(!text.includes('按会话创建时间与最后提问时间逐会话判定'));
}

// ------------------------- an unattributable session is surfaced, not hidden
{
  const partial = ledgerAt({ total: 162631, month: 100000, monthSource: 'mixed', exact: false, unattributed: 3 });
  const text = at(partial, { open: true });
  assert.ok(text.includes('有 3 个会话创建于本月之前、本月又用过'), 'the unknowable sessions are named');
  assert.ok(text.includes('未计入本月'), 'and the consequence is stated');
  assert.ok(!text.includes('不含估算'), 'a month with an unknowable session must not claim exactness');
}

// A month with nothing in it yet must read as an honest zero.
{
  const fresh = ledgerAt({ total: 162631, month: 0, monthSource: 'idle', exact: true, unattributed: 0 });
  assert.ok(at(fresh).includes('本月消耗Token0'), 'the rollover reads as zero, not as a missing value');
}

// ------------------------------------------------------------- boundaries
{
  const scale = (n) => ({ ...ledgerAt({ total: n, month: n, monthSource: 'born', exact: true, unattributed: 0 }), totals: { uncachedInputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } });
  assert.ok(at(scale(1_500_000_000)).includes('本月消耗Token15亿'), 'a billion-scale count reads in 亿');
  assert.ok(at(scale(276_674_653)).includes('本月消耗Token2.77亿'), 'hundreds of millions read in 亿');
  assert.ok(at(scale(29_460)).includes('本月消耗Token2.95万'), 'tens of thousands read in 万, not 0.00亿');
  assert.ok(at(scale(999)).includes('本月消耗Token999'), 'a count under 万 stays an exact integer');
  assert.ok(at(scale(10_000)).includes('本月消耗Token1万'), 'the 万 tier starts exactly at ten thousand');
  assert.ok(at(scale(10_000_000_000)).includes('本月消耗Token100亿'), 'trailing zeros are trimmed at the 亿 tier');
}

// -------------------------------- skipped forked sessions stay surfaced
{
  const text = at({ ...ledgerAt(EXACT), sessions: { ...SESSIONS, skippedSeeded: 2 } }, { open: true });
  assert.ok(text.includes('2 个分叉会话'), 'skipped seeded sessions must be reported');
}

// A disconnected stream must say so without discarding the last value.
{
  const text = at(ledgerAt(EXACT), { live: false, open: true });
  assert.ok(text.includes('连接中断'), 'a dropped stream must be reported');
  assert.ok(text.includes('本机历史累计（仅 DSH）合计16.26万'), 'the last synced value stays on screen');
}

// ------------------------------------------------ the tracked-key headline
// A key's month total is the headline; the machine-wide figure it used to show
// stays in the panel underneath it.
const TRACKED = {
  keys: [{
    short: '64134cfa',
    ref: 'DEEPSEEK_API_KEY',
    providers: ['deepseek-official', 'vision-toolkit-deepseek-official'],
    // The host sends two different periods on purpose: `month` is this month,
    // `totals` is all-time (it mirrors the local all-time figure), and `days`
    // plus `models` are month-scoped. They are deliberately far apart here so
    // that showing the wrong one cannot pass.
    month: 13_200_000,
    totals: { uncachedInputTokens: 4_000_000, outputTokens: 1_000_000, cacheReadTokens: 35_000_000, cacheWriteTokens: 0 },
    days: { '2026-09-24': { uncachedInputTokens: 1_000_000, outputTokens: 200_000, cacheReadTokens: 12_000_000, cacheWriteTokens: 0 } },
    models: {
      'deepseek-v4-pro': { uncachedInputTokens: 900_000, outputTokens: 180_000, cacheReadTokens: 10_000_000, cacheWriteTokens: 0 },
      'deepseek-v4-flash': { uncachedInputTokens: 100_000, outputTokens: 20_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 },
    },
    instances: [
      { instance: 'a', label: '本机', month: '2026-09', seq: 12, reportedAt: 0, ageMs: 30_000, stale: false, total: 8_000_000 },
      { instance: 'b', label: '虚拟机1', month: '2026-09', seq: 4, reportedAt: 0, ageMs: 7_200_000, stale: true, total: 5_200_000 },
    ],
  }],
  uncovered: [],
  failures: [],
  coverage: 'dsh+opencode',
  role: 'aggregator',
  collector: { state: 'listening', host: '0.0.0.0', port: 3939, instances: 2 },
  reporter: { state: 'off' },
};
const withTracked = (tracked, tools) => ({ ...ledgerAt(EXACT, tools), tracked });
const trackedAt = (tracked, options) => at(withTracked(tracked), options);

/** Every element in a tree whose props carry `name`. */
function nodesWith(node, name, out = []) {
  if (node === null || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) nodesWith(child, name, out);
    return out;
  }
  if (typeof node.type === 'function') {
    nodesWith(node.type(node.props ?? {}), name, out);
    return out;
  }
  if (node.props !== undefined && Object.hasOwn(node.props, name)) out.push(node);
  nodesWith(node.props?.children, name, out);
  return out;
}

{
  const text = trackedAt(TRACKED);
  assert.ok(text.includes('我的 key · 本月'), 'the row names the subject, not just the period');
  assert.ok(text.includes('1320万'), 'the row sums the tracked keys, not the machine');
  // The headline is the month, never the all-time bucket set that rides
  // alongside it in the same payload.
  assert.ok(!text.includes('4000万'), 'the all-time figure must never be shown as the month');
  assert.ok(!text.includes('本月消耗Token'), 'the machine-wide wording gives way when a key is tracked');
}

// ------------------------------------------------ the tracked-key panel body
{
  // Paired with a working opencode so the payload is genuinely clean: every
  // warning found below then belongs to the tracked section and nothing else.
  const tree = treeAt(withTracked(TRACKED, { opencode: OPENCODE_OK }), { open: true });
  const text = render(tree);
  for (const fragment of [
    '我这把 key 的消耗',
    '按 key 归集 · 2026-09 起',
    '我的 key（跨机归集）',
    '64134cfa · DEEPSEEK_API_KEY',
    '1320万',
    // The all-time figure is present, and labelled as such.
    '该 key 历史累计',
    '4000万',
    // Each peer keeps its own figure, and the stale one says so in words.
    '本机 · 刚刚',
    '800万',
    '虚拟机1 · 2 小时前 · 陈旧',
    '520万',
    '按模型',
    'deepseek-v4-pro',
    '1108万',
    'deepseek-v4-flash',
    '212万',
    // The coverage declaration is a visible line, never a hover title.
    '覆盖范围：仅 DSH + opencode',
    '这是下界，不是总量',
    '聚合器 · 0.0.0.0:3939 · 已收 2 台',
    // The pre-existing blocks survive untouched beneath it.
    '本月消耗本机 DSH10万',
    '本机历史累计（仅 DSH）合计16.26万',
    '计入会话12 个（1 个在运行）',
  ]) {
    assert.ok(text.includes(fragment), `the tracked panel must show "${fragment}", got: ${text}`);
  }
  assert.ok(!text.includes('上报'), 'a reporter that is off earns no row');
  // A stale peer is tinted, not dropped.
  assert.equal(nodesWith(tree, 'data-stale').length, 1, 'exactly the stale peer carries the stale mark');
  // Coverage is not a tooltip.
  assert.equal(nodesWith(tree, 'data-coverage').length, 1, 'the coverage line is rendered, not hidden in a title');
  assert.equal(nodesWith(tree, 'data-warn').length, 0, 'a healthy tracked payload has nothing to warn about');
}

// ---------------------------------------- uncovered routes and broken keys
{
  const tracked = {
    ...TRACKED,
    uncovered: ['modlens-deepseek'],
    failures: [
      { ref: 'BACKUP_KEY', provider: 'deepseek-official', reason: 'missing' },
      { ref: 'ODD_KEY', provider: 'deepseek-official', reason: 'invalidPattern', detail: '[unclosed' },
      { ref: 'WEIRD_KEY', provider: 'deepseek-official', reason: 'somethingNew' },
    ],
    collector: { state: 'error' },
    reporter: { state: 'ok', url: 'http://10.0.0.5:3939/ingest', lastAt: Date.now() - 120_000 },
  };
  const tree = treeAt(withTracked(tracked), { open: true });
  const text = render(tree);
  for (const fragment of [
    '有 1 个路由出现在会话日志里',
    'modlens-deepseek',
    '加进该 key 配置的 providers 或 providerPatterns',
    '凭证 BACKUP_KEY 取不到值',
    '凭证 ODD_KEY 的 providerPatterns 里有无法编译的模式（[unclosed）',
    '凭证 WEIRD_KEY 无法解析（somethingNew）',
    '聚合器异常（error）',
    '上报 · http://10.0.0.5:3939/ingest · 最后 2 分钟前',
  ]) {
    assert.ok(text.includes(fragment), `the warning panel must show "${fragment}", got: ${text}`);
  }
  // Every warning line is actually tinted: surfaced in words AND in colour.
  assert.ok(nodesWith(tree, 'data-warn').length >= 6, 'each uncovered route, failure, and broken link is tinted');
  assert.equal(nodesWith(tree, 'data-coverage').length, 1, 'coverage stays declared even when everything else is red');
}

// ------------------------------------- the host's real link-state vocabulary
// These are the states the host actually publishes. Each must read as words,
// never as a raw state token, and "off" must add no row at all.
{
  const cases = [
    ['collector', { state: 'starting' }, '聚合器正在启动'],
    ['collector', { state: 'listening', host: '100.64.0.2', port: 4000, instances: 3 }, '聚合器 · 100.64.0.2:4000 · 已收 3 台'],
    ['collector', { state: 'portInUse' }, '聚合器状态：portInUse'],
    ['reporter', { state: 'idle', url: 'http://10.0.0.5:3939/ingest' }, '上报已就绪 · http://10.0.0.5:3939/ingest · 暂无可报数据'],
    ['reporter', { state: 'noUrl' }, '上报已开启，但没有配置聚合器地址'],
    ['reporter', { state: 'unsupported', url: 'http://x/ingest' }, '没有 fetch'],
    ['reporter', { state: 'ok', url: 'http://x/ingest', lastAt: Date.now() - 5_000 }, '上报 · http://x/ingest · 最后 刚刚'],
  ];
  for (const [kind, section, fragment] of cases) {
    const text = trackedAt({ ...TRACKED, collector: { state: 'off' }, reporter: { state: 'off' }, [kind]: section }, { open: true });
    assert.ok(text.includes(fragment), `${kind} ${section.state} must read as "${fragment}", got: ${text}`);
  }
  // Off is not a state worth a line.
  for (const kind of ['collector', 'reporter']) {
    const text = trackedAt({ ...TRACKED, collector: { state: 'off' }, reporter: { state: 'off' } }, { open: true });
    assert.ok(!text.includes('聚合器') && !text.includes('上报'), `a ${kind} that is off adds no row`);
  }
  // Every non-off state carries the warning colour, and only a failure does.
  const starting = treeAt(withTracked({ ...TRACKED, collector: { state: 'starting' }, reporter: { state: 'off' } }, { opencode: OPENCODE_OK }), { open: true });
  assert.equal(nodesWith(starting, 'data-warn').length, 0, 'a starting aggregator is not a failure');
  const broken = treeAt(withTracked({ ...TRACKED, collector: { state: 'error' }, reporter: { state: 'error' } }, { opencode: OPENCODE_OK }), { open: true });
  assert.equal(nodesWith(broken, 'data-warn').length, 2, 'both broken links are tinted');
  // A reporter that cannot work at all is a warning, not a footnote.
  for (const state of ['unsupported', 'noUrl']) {
    const tree = treeAt(withTracked({ ...TRACKED, collector: { state: 'off' }, reporter: { state } }, { opencode: OPENCODE_OK }), { open: true });
    assert.equal(nodesWith(tree, 'data-warn').length, 1, `a reporter in state ${state} is tinted`);
  }
}

// ------------------- a peer's key is neither mine nor invisible
// An aggregator's key list carries keys other machines reported. Those are real
// usage, but they are not this machine's credential: adding them under a label
// that says "my key" answers a different question than the one it asks, while
// dropping them would make a number that exists disappear.
{
  const PEERED = {
    ...TRACKED,
    keys: [
      { ...TRACKED.keys[0], trackedHere: true },
      {
        short: 'deadbeef',
        ref: 'COLLEAGUE_KEY',
        providers: [],
        trackedHere: false,
        month: 7_000_000,
        totals: { uncachedInputTokens: 7_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        days: { '2026-09-24': { uncachedInputTokens: 7_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
        models: {},
        instances: [{ instance: 'c', label: '同事的机器', month: '2026-09', seq: 1, reportedAt: 0, ageMs: 1000, stale: false, total: 7_000_000 }],
      },
    ],
  };
  const opened = trackedAt(PEERED, { open: true });
  // Everything before the first caption is the row itself, so a number that
  // appears only later cannot have come from the headline.
  const row = opened.slice(0, opened.indexOf('我的 key（跨机归集）'));
  assert.ok(row.includes('1320万'), 'the row shows my key');
  assert.ok(!row.includes('700万'), 'a peer-reported key never reaches the headline');
  assert.ok(opened.includes('对端上报的其他 key'), 'it is listed apart, under its own caption');
  assert.ok(opened.includes('COLLEAGUE_KEY'), 'named, so the figure does not vanish');
  assert.ok(opened.includes('700万'), 'and its own number is still shown');

  // A host that sends no flag at all is an older host: every key is local, as
  // it was before this distinction existed.
  const unflagged = trackedAt({ ...TRACKED, keys: [{ ...TRACKED.keys[0] }] });
  assert.ok(unflagged.includes('1320万'), 'a missing flag means local, not peer');
}

// ---------------------------------------------- backward compatibility
// An older host sends no `tracked` at all: the row must read exactly as it did
// before this section existed.
{
  const text = at(ledgerAt(EXACT));
  assert.ok(text.includes('本月消耗Token10万'), 'a payload without `tracked` keeps the machine-wide row');
  const opened = at(ledgerAt(EXACT), { open: true });
  assert.ok(!opened.includes('我的 key'), 'no tracked block is invented');
  assert.ok(!opened.includes('覆盖范围'), 'an older payload claims no coverage it cannot state');
  assert.ok(opened.includes('本月消耗本机 DSH10万'), 'and the panel is otherwise unchanged');
}

// A host whose owner configured no tracked key sends an empty list: that is
// the same fallback, not a blank or a zero.
{
  const empty = { ...TRACKED, keys: [] };
  const text = at(withTracked(empty));
  assert.ok(text.includes('本月消耗Token10万'), 'an empty key list falls back to the machine month');
  assert.ok(!text.includes('我的 key'), 'and does not relabel the row');
  const opened = at(withTracked(empty), { open: true });
  assert.ok(!opened.includes('我的 key（跨机归集）'), 'no tracked block is drawn for an empty list');
  assert.ok(opened.includes('覆盖范围：仅 DSH + opencode'), 'the coverage declaration still stands');
  assert.ok(opened.includes('本机历史累计（仅 DSH）合计16.26万'), 'the legacy blocks are untouched');
}

// A key with nothing counted yet, and a peer whose age is unknown, must both
// render rather than vanish.
{
  const sparse = {
    ...TRACKED,
    keys: [{ short: 'ffffffff', ref: 'NEW_KEY', providers: [], month: 0, totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, models: {}, instances: [{ instance: 'x', label: '新机器', total: 0 }] }],
    collector: { state: 'connecting' },
  };
  const text = trackedAt(sparse, { open: true });
  assert.ok(text.includes('ffffffff · NEW_KEY'), 'a zero-total key is still named');
  assert.ok(text.includes('新机器'), 'a peer with no reported age still appears');
  assert.ok(text.includes('聚合器状态：connecting'), 'an unknown-but-not-failed state is reported verbatim');
  assert.ok(at({ ...ledgerAt(EXACT), tracked: sparse }).includes('我的 key · 本月0'), 'a tracked key with nothing yet reads as an honest zero, not as pending');
}

// A host that sends no usable month figure at all must not silently substitute
// the all-time bucket set: the fallback is the month-scoped `days`, and when
// even that is absent the row reads as unknown.
{
  const noMonth = {
    ...TRACKED,
    keys: [{
      short: 'abcdef01', ref: 'LEGACY_KEY', providers: [], totals: { uncachedInputTokens: 40_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      days: { '2026-09-02': { uncachedInputTokens: 7_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      models: {}, instances: [],
    }],
  };
  assert.ok(at(withTracked(noMonth)).includes('700万'), 'without a month figure the month-scoped days are summed');
  assert.ok(!at(withTracked(noMonth)).includes('4000万'), 'and the all-time set is still not passed off as the month');
}

// The closed row falls back to "measuring" until the first payload arrives,
// with or without a tracked section.
{
  assert.ok(at(null).includes('统计中'), 'no payload at all still reads as pending');
}

// Every dictionary key the render paths touched must exist in both locales.
assert.ok(asked.length > 0);
console.log(`client.test.mjs: all checks passed (${asked.length} dictionary keys exercised)`);
