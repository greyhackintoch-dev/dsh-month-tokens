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
// Totals taken from the real stores, so the rendered figures are the ones a
// user of this machine would actually see.
const PEN_OK = { state: 'ok', totals: { uncachedInputTokens: 98_519, outputTokens: 184_277, cacheReadTokens: 6_512_736, cacheWriteTokens: 0 }, messages: 83, fetchedAt: 0 };
const WORKBUDDY_OK = { state: 'ok', totals: { uncachedInputTokens: 145_398, outputTokens: 13_529, cacheReadTokens: 1_455_360, cacheWriteTokens: 0 }, messages: 22, fetchedAt: 0 };
/** Total tokens in one bucket set. */
const sumOf = (set) => set.uncachedInputTokens + set.outputTokens + set.cacheReadTokens + set.cacheWriteTokens;
/** The machine headline: this home plus every reader that has a row. */
const toolsTotal = (tools) => Object.values(tools).reduce((sum, tool) => (tool?.state === 'ok' ? sum + sumOf(tool.totals) : sum), 0);
const ledgerAt = (local, tools = { opencode: { state: 'absent' } }) => ({
  revision: 9,
  period: PERIOD,
  totals: LOCAL,
  month: local.month + toolsTotal(tools),
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
    '仅本机 DSH · 2026-09 起',
    // Each assertion spans a caption or label and its value, so a right number
    // on the wrong row cannot pass.
    '本月消耗本机 DSH10万',
    '计入会话12 个（1 个在运行）',
  ]) {
    assert.ok(text.includes(fragment), `the open panel must show "${fragment}", got: ${text}`);
  }
  // The panel answers "how much, and where from". The model split, the
  // machine's all-time bucket breakdown, and the standing prose moved out of it
  // by request; this is what keeps them from creeping back in.
  for (const gone of ['按模型', '本机历史累计', '未缓存输入', '缓存命中', '缓存写入', '统计周期', '按会话创建时间']) {
    assert.ok(!text.includes(gone), `the trimmed panel must not show "${gone}", got: ${text}`);
  }
  assert.ok(!text.includes('无法拆分月份归属'), 'an exact month carries no caveat');
  assert.ok(!text.includes('本月消耗 Token'), 'the head does not restate the label the row already carries');
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
  ]) {
    assert.ok(text.includes(fragment), `the opencode panel must show "${fragment}", got: ${text}`);
  }
  assert.ok(!text.includes('未找到 opencode 数据库'), 'a working database carries no absence note');
  // The headline adds the two sources; the row above it must not double count.
  assert.ok(at(ledgerAt(EXACT, { opencode: OPENCODE_OK })).includes('本月消耗Token1487.7万'), 'the row shows DSH + opencode');
}

// ------------------- Pen and WorkBuddy: two more rows, same contract
{
  const all = { opencode: OPENCODE_OK, pen: PEN_OK, workbuddy: WORKBUDDY_OK };
  const text = at(ledgerAt(EXACT, all), { open: true });
  for (const fragment of [
    // Label paired with its own value, so a right number on the wrong row
    // cannot pass.
    'Pen679.55万',
    'WorkBuddy161.43万',
    'opencode1477.7万',
    '本机 DSH + opencode + Pen + WorkBuddy · 2026-09 起',
  ]) {
    assert.ok(text.includes(fragment), `the panel must show "${fragment}", got: ${text}`);
  }
  // The headline is the sum of everything with a row.
  assert.ok(at(ledgerAt(EXACT, all)).includes('本月消耗Token2328.68万'), 'the headline adds every platform that has a row');
}

// ---------- a platform with no record keeps its row off the panel entirely
{
  const onlyPen = at(ledgerAt(EXACT, { pen: PEN_OK }), { open: true });
  assert.ok(onlyPen.includes('Pen679.55万'), 'Pen renders when it has a record');
  assert.ok(!onlyPen.includes('WorkBuddy'), 'a platform with no record is not listed');
  assert.ok(!onlyPen.includes('opencode'), 'and neither is one that is absent');
  assert.ok(onlyPen.includes('本机 DSH + Pen · 2026-09 起'), 'the subtitle names only what is actually counted');
  assert.ok(!onlyPen.includes('未找到 opencode'), 'an absent reader is quiet when another one is carrying the panel');
}

// ------------------- each new reader's failure mode gets its own sentence
{
  const cases = [
    ['absent', '未找到 Pen 的本月记录'],
    ['drift', 'Pen 的记录结构已变化'],
    ['unreadable', 'Pen 的凭证文件读不了'],
    ['error', 'Pen 用量读取失败'],
  ];
  for (const [state, fragment] of cases) {
    const text = at(ledgerAt(EXACT, { opencode: { state: 'absent' }, pen: { state, message: 'boom' } }), { open: true });
    assert.ok(text.includes(fragment), `Pen state ${state} must say "${fragment}", got: ${text}`);
  }
  const wbText = at(ledgerAt(EXACT, { opencode: { state: 'absent' }, workbuddy: { state: 'drift', message: 'x' } }), { open: true });
  assert.ok(wbText.includes('WorkBuddy 的记录结构已变化'), 'the same states are named for WorkBuddy');
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
    assert.ok(text.includes('本月消耗本机 DSH10万'), `state ${state} must not disturb the DSH figures`);
  }
}

// ------------------------------- period provenance is no longer narrated
{
  const text = at(ledgerAt({ ...EXACT, monthSource: 'ledger' }), { open: true });
  assert.ok(!text.includes('按日历日精确汇总'), 'the provenance prose is gone from the panel');
  assert.ok(text.includes('本月消耗本机 DSH10万'), 'while the figure it described still stands');
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

// ------------------- the forked-session shortfall is no longer narrated
// It measured the machine-wide row, which the panel no longer headlines. The
// key's own figure excludes a fork's inherited prefix instead (lib/attribution),
// so the remaining caveat is a fact about a row nobody opens this panel for.
{
  const text = at({ ...ledgerAt(EXACT), sessions: { ...SESSIONS, skippedSeeded: 2 } }, { open: true });
  assert.ok(!text.includes('分叉会话'), 'the machine row\'s shortfall is not narrated here');
  assert.ok(text.includes('本月消耗本机 DSH10万'), 'while the row itself is unchanged');
}

// A disconnected stream must say so without discarding the last value.
{
  const text = at(ledgerAt(EXACT), { live: false, open: true });
  assert.ok(text.includes('连接中断'), 'a dropped stream must be reported');
  assert.ok(text.includes('本月消耗本机 DSH10万'), 'the last synced value stays on screen');
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

// ------------------------------------------------ the 7-day sparkline
// The shape rides with the key's own figures. `days` is month-scoped by
// contract, so the chart draws what exists and labels that range — it never
// pads a day it has no record of, because a padded zero would read as "nothing
// was spent" rather than "nothing was kept".
{
  const day = (date, tokens) => [date, { uncachedInputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }];
  const withDays = (pairs) => ({ ...TRACKED, keys: [{ ...TRACKED.keys[0], days: Object.fromEntries(pairs) }] });

  const seven = trackedAt(withDays([
    day('2026-09-18', 1_000_000), day('2026-09-19', 2_000_000), day('2026-09-20', 500_000),
    day('2026-09-21', 4_000_000), day('2026-09-22', 3_000_000), day('2026-09-23', 1_500_000),
    day('2026-09-24', 5_000_000),
  ]), { open: true });
  assert.ok(seven.includes('最近 7 天'), `the chart must be labelled, got: ${seven}`);
  assert.ok(seven.includes('9/18–9/24'), 'and must state the range it actually drew');
  const sevenTree = treeAt(withTracked(withDays([
    day('2026-09-18', 1_000_000), day('2026-09-19', 2_000_000), day('2026-09-20', 500_000),
    day('2026-09-21', 4_000_000), day('2026-09-22', 3_000_000), day('2026-09-23', 1_500_000),
    day('2026-09-24', 5_000_000),
  ])), { open: true });
  // The accessible name is an attribute, not text, so it survives a serialiser
  // that strips the chart down to a label — which is the point of having one.
  assert.equal(
    nodesWith(sevenTree, 'aria-label').map((node) => node.props['aria-label']).find((label) => label.includes('每日消耗')),
    '2026-09-18 至 2026-09-24，共 7 天的每日消耗',
  );

  // Eight days in: the window is the last seven, oldest first.
  const tree = treeAt(withTracked(withDays([
    day('2026-09-17', 9_000_000), day('2026-09-18', 1_000_000), day('2026-09-19', 2_000_000),
    day('2026-09-20', 500_000), day('2026-09-21', 4_000_000), day('2026-09-22', 3_000_000),
    day('2026-09-23', 1_500_000), day('2026-09-24', 5_000_000),
  ])), { open: true });
  const columns = nodesWith(tree, 'data-day');
  assert.equal(columns.length, 7, 'exactly seven columns, whatever the month holds');
  assert.deepEqual(
    columns.map((node) => node.props['data-day']),
    ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'],
    'oldest first, and the 17th drops off the back',
  );
  // Each column carries its own exact figure; the outlier is the peak, so the
  // line has to be drawn against it rather than against the last point.
  const titles = nodesWith(tree, 'data-day').map((node) => render(node));
  assert.ok(titles.some((text) => text.includes('2026-09-21') && text.includes('400万')), `a column must name its own day and figure, got: ${titles.join(' | ')}`);
  assert.equal(nodesWith(tree, 'vectorEffect').length, 1, 'one polyline, no chart library');

  // One day is a dot, not a trend.
  assert.ok(!trackedAt(withDays([day('2026-09-24', 5_000_000)]), { open: true }).includes('最近'), 'a single day must not be drawn as a trend');
  assert.equal(nodesWith(treeAt(withTracked(withDays([day('2026-09-24', 5_000_000)])), { open: true }), 'data-day').length, 0);
  // No day map at all is the same case.
  assert.equal(nodesWith(treeAt(withTracked(TRACKED), { open: true }), 'data-day').length, 0, 'the one-day fixture in TRACKED draws nothing');

  // Early in a month there are fewer days to draw, and the label says so
  // instead of padding the axis back to seven.
  const early = trackedAt(withDays([day('2026-10-01', 1_000), day('2026-10-02', 2_000), day('2026-10-03', 3_000)]), { open: true });
  assert.ok(early.includes('最近 3 天'), 'the label counts the days actually drawn');
  assert.ok(early.includes('10/1–10/3'));
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
    '按 key 归集 · 2026-09 起',
    '我的 key（跨机归集）',
    '64134cfa · DEEPSEEK_API_KEY',
    '1320万',
    // The all-time figure is present, and labelled as such.
    '该 key 历史累计',
    '4000万',
    // Each machine keeps its own figure, and the stale one says so in words.
    '本机 · 刚刚',
    '800万',
    '虚拟机1 · 2 小时前 · 陈旧',
    '520万',
    // The per-platform rows are what "where from" means here.
    '本月消耗本机 DSH10万',
    'opencode1477.7万',
    '计入会话12 个（1 个在运行）',
  ]) {
    assert.ok(text.includes(fragment), `the tracked panel must show "${fragment}", got: ${text}`);
  }
  // A stale peer is tinted, not dropped.
  assert.equal(nodesWith(tree, 'data-stale').length, 1, 'exactly the stale peer carries the stale mark');
  // Nothing is being excluded from this payload, so nothing is warned about.
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
  ]) {
    assert.ok(text.includes(fragment), `the warning panel must show "${fragment}", got: ${text}`);
  }
  // Every warning line is actually tinted: surfaced in words AND in colour.
  assert.ok(nodesWith(tree, 'data-warn').length >= 5, 'each uncovered route and failure is tinted');
  // The aggregator's own health is not this panel's job any more, even when it
  // is broken: the panel is read for what this key spent.
  assert.ok(!text.includes('聚合器') && !text.includes('上报'), 'link states are not narrated here');
}

// ------------------- link states are the host's business, not the panel's
// The collector and reporter states used to be narrated here. They describe
// whether *other machines* can reach this one — operational news, not a
// spending figure — so the panel no longer carries them, not even when they are
// broken. What must not disappear with them is the pair of warnings that report
// an exclusion, which the block above pins.
{
  for (const section of [
    { collector: { state: 'listening', host: '0.0.0.0', port: 3939, instances: 2 } },
    { collector: { state: 'error' } },
    { collector: { state: 'portInUse' } },
    { reporter: { state: 'ok', url: 'http://x/ingest', lastAt: 0 } },
    { reporter: { state: 'noUrl' } },
    { reporter: { state: 'unsupported' } },
  ]) {
    const kind = Object.keys(section)[0];
    // A working opencode, so the only thing that could warn is the link state.
    const tree = treeAt(withTracked({ ...TRACKED, ...section }, { opencode: OPENCODE_OK }), { open: true });
    const text = render(tree);
    assert.ok(!text.includes('聚合器') && !text.includes('上报'), `a ${kind} state adds no row, got: ${text}`);
    assert.equal(nodesWith(tree, 'data-warn').length, 0, `a ${kind} state is not a spending warning`);
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
  assert.ok(!opened.includes('覆盖范围'), 'no coverage prose is drawn, on any payload');
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
  assert.ok(!opened.includes('覆盖范围'), 'and still no coverage prose, for an empty key list');
  assert.ok(opened.includes('本月消耗本机 DSH10万'), 'while the per-platform rows are untouched');
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
