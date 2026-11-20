import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'client.js')
const source = readFileSync(bundlePath, 'utf8')

/**
 * Execute the browser bundle's registration and materialize its factory with
 * a minimal React double, so a typo or a missing import fails here instead of
 * silently producing an empty panel in the browser.
 * @returns {object} the materialized module exports.
 */
function loadBundle() {
  let registered
  globalThis.window = { __ModuleLoader__: { load: (entry) => { registered = entry } } }
  try {
    new Function(source)()
  } finally {
    delete globalThis.window
  }
  assert.ok(registered !== undefined, 'the bundle calls window.__ModuleLoader__.load')
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  }
  return registered.factory((name) => (name === 'react' ? React : {}))
}

test('the client bundle registers with the package name and slug-free id', () => {
  const mod = loadBundle()
  assert.equal(mod.name, 'siliconflow-image')
  assert.deepEqual(mod.inject, ['slots', 'locale', 'sessions', 'modelDirectories'])
  assert.equal(typeof mod.apply, 'function')
})

test('the parameter bar renders nothing unless the image provider is selected', () => {
  const mod = loadBundle()
  const t = (key) => key
  const bar = mod.ParamsBar

  const hidden = bar({ t, session: { sessionId: 's1' }, directory: undefined })
  assert.equal(hidden, null)

  const otherRoute = bar({
    t,
    session: { sessionId: 's1' },
    directory: {
      subscribe: () => () => {},
      getSnapshot: () => ({ status: 'ready', current: { provider: 'siliconflow', model: 'deepseek-ai/DeepSeek-V4.1-Flash' }, groups: [] }),
    },
  })
  assert.equal(otherRoute, null, 'a chat model never shows the image form')
})

test('the parameter bar shows the four playground fields for an image model', () => {
  const mod = loadBundle()
  const t = (key) => key
  const tree = mod.ParamsBar({
    t,
    defaultOpen: true,
    session: { sessionId: 's1' },
    directory: {
      subscribe: () => () => {},
      getSnapshot: () => ({ status: 'ready', current: { provider: 'siliconflow-image', model: 'OpenMOSS-Team/MOSS-Image' }, groups: [] }),
    },
  })
  assert.ok(tree !== null, 'an image model shows the bar')
  const text = JSON.stringify(tree)
  for (const label of ['size', 'steps', 'seed', 'negative']) assert.ok(text.includes(`\"${label}\"`), `the form has the ${label} row`)
})

/**
 * Pull one CSS rule body out of the bundle's injected style sheet.
 * @param {string} selector - exact selector text, e.g. `.sfi-sizes`.
 * @returns {string} the declarations inside its braces.
 */
function cssRule(selector) {
  const start = source.indexOf(`${selector}{`)
  assert.notEqual(start, -1, `the bundle styles ${selector}`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  return source.slice(open + 1, close)
}

test('size buttons share one flex column, matching the playground radio group', () => {
  // The playground lays the eight ratio options out as flex-1 columns that fill
  // the row. Without this, buttons size to their label ("1:1" is wider than
  // "16:9") and the last one leaves a trailing gap.
  const row = cssRule('.sfi-sizes')
  assert.match(row, /display:flex/)
  assert.match(row, /width:100%/)
  const button = cssRule('.sfi-size')
  assert.match(button, /flex:1 1 0/, 'every size gets the same column width')
  assert.match(button, /min-width:0/, 'a long label cannot widen its column')
  assert.doesNotMatch(button, /min-width:64px/, 'a fixed minimum reintroduces uneven columns')
  assert.doesNotMatch(row, /flex-wrap:wrap/, 'a wrapping row would break the equal-column grid')
})

test('every row control shares one height so a line sits on one baseline', () => {
  for (const selector of ['.sfi-num', '.sfi-btn']) {
    const rule = cssRule(selector)
    assert.match(rule, /box-sizing:border-box/, `${selector} must include its border in height`)
    assert.match(rule, /height:30px/, `${selector} must be 30px tall`)
  }
})

test('the seed input grows while the randomize action stays pinned right', () => {
  assert.match(cssRule('.sfi-num.sfi-grow'), /flex:1 1 auto/)
  assert.match(cssRule('.sfi-growwrap'), /width:100%/)
  // The footer action must not stretch: a growing wrapper there pushed the
  // reset button into the middle of the row.
  const actions = cssRule('.sfi-actions')
  assert.match(actions, /flex:0 0 auto/)
  assert.match(cssRule('.sfi-hint'), /flex:1 1 auto/)
})

test('the panel insets itself to the visible composer card, not the dock slot', () => {
  // The dock slot is `display:contents` and spans the composer STACK, which
  // includes the card's horizontal padding. A collapsed pill then pokes out
  // past the card it labels — the reported "歪的" screenshot. The wrapper pads
  // by a measured custom property instead of a guessed constant.
  const wrap = cssRule('.sfi-wrap')
  assert.match(wrap, /padding:0 var\(--sfi-inset,16px\)/, 'inset comes from the measured property, with a first-paint fallback')
  assert.match(wrap, /box-sizing:border-box/, 'the inset must not widen the wrapper')

  // The measurement must climb past `display:contents` ancestors: reading
  // parentElement there yields a zero box and a bogus inset.
  assert.match(source, /box\.width > 0 && box\.height > 0/, 'skips boxless (display:contents) ancestors')
  assert.match(source, /--sfi-inset/, 'publishes the measured inset')
  assert.match(source, /ResizeObserver/, 're-measures when the shell relayouts')
})
