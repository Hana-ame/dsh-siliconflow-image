import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { apply, DENY_GLOBAL, inject, name } from '../preset-tool.js'
import { fakeResponse, pngBytes } from './helpers.js'

/** Register doubles and capture what preset-tool registers / denies. */
function fakeScope({ withGet = true } = {}) {
  const registered = []
  const state = { restricted: null }
  const saved = []
  const ctx = {
    ...(withGet
      ? {
          get(n) {
            if (n === 'credentials') return { async resolve() { return { value: 'sk-test', source: 'file' } } }
            if (n === 'attachments') {
              return { async saveImage(input) { saved.push(input); return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1024, height: 768, name: input.name } } }
            }
            return undefined
          },
        }
      : {}),
    tools: {
      register(def) { registered.push(def) },
      restrict(o) { state.restricted = o },
    },
  }
  return { ctx, registered, state, saved }
}

/** Reuse the tool.test.js fetch stub shape: one URL from generation, PNG from download. */
function stubFetch(bytes = pngBytes(1024, 768)) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).includes('/images/generations')) {
      return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }], seed: 7 } })
    }
    return fakeResponse({ bytes, contentType: 'image/png' })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const config = {
  apiKeyRef: 'SILICONFLOW_API_KEY',
  baseURL: 'https://api.siliconflow.cn/v1',
  outputDir: 'generated-images',
  defaultModel: 'Kwai-Kolors/Kolors',
  watermark: false,
  timeoutMs: 180_000,
}

const pluginMeta = () => ({ name, inject })

test('exports the expected plugin face', () => {
  const meta = pluginMeta()
  assert.equal(meta.name, 'siliconflow-image-preset-tool')
  assert.deepEqual(meta.inject, ['tools'])
  assert.equal(typeof apply, 'function')
})

test('registers exactly one tool named generate_image', () => {
  const { ctx, registered } = fakeScope()
  apply(ctx, config)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, 'generate_image')
})

test('denies the inherited global tools so the scope stays image-only', () => {
  const { ctx, state } = fakeScope()
  apply(ctx, config)
  const restricted = state.restricted
  assert.ok(Array.isArray(restricted?.deny))
  assert.ok(restricted.deny.includes('browser_click'))
  assert.ok(restricted.deny.includes('web_search'))
  // inject_* are scope-only tools, NOT Host-global; denying them throws
  // "names unknown global tools" on every activation, so they must stay out.
  assert.ok(!restricted.deny.includes('inject_deliver'))
  assert.ok(!restricted.deny.includes('inject_context_read'))
  assert.ok(!restricted.deny.includes('inject_user_inputs'))
  // Never deny this scope's own registration.
  assert.ok(!restricted.deny.includes('generate_image'))
  assert.equal(restricted.deny.length, DENY_GLOBAL.length)
})

test('execute works over a preset scope with no ctx.get (paramStore absent)', async () => {
  const { ctx, registered } = fakeScope({ withGet: false })
  apply(ctx, config)
  const tool = registered[0]
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-siliconflow-image-preset-'))
  const session = { header: { cwd: workspace } }
  const exec = { agent: { session }, callId: 'call-1', signal: new AbortController().signal }
  const { restore } = stubFetch()
  // No ctx.get → credentials seam unavailable → key resolves from env.
  process.env.SILICONFLOW_API_KEY = 'sk-env-test'
  try {
    const value = await tool.execute({ prompt: '一只蓝鸟' }, exec)
    assert.equal(value.model, 'Kwai-Kolors/Kolors')
    assert.equal(value.images.length, 1)
    assert.ok(path.isAbsolute(value.images[0].path))
    const onDisk = await readFile(value.images[0].path)
    assert.equal(onDisk.byteLength, pngBytes().byteLength)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('execute still generates when the scope lacks attachments (attachment is optional)', async () => {
  const { ctx, registered } = fakeScope({ withGet: false })
  apply(ctx, config)
  const tool = registered[0]
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-siliconflow-image-preset-'))
  const session = { header: { cwd: workspace } }
  const exec = { agent: { session }, callId: 'call-2', signal: new AbortController().signal }
  const { restore } = stubFetch()
  process.env.SILICONFLOW_API_KEY = 'sk-env-test'
  try {
    const value = await tool.execute({ prompt: '一只白猫' }, exec)
    // No attachment id — the file on disk is still the deliverable.
    assert.equal(value.images[0].attachment, undefined)
    assert.ok(value.images[0].bytes > 0)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('execute renders the image block so the model inlines it', async () => {
  const { ctx, registered } = fakeScope()
  apply(ctx, config)
  const tool = registered[0]
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-siliconflow-image-preset-'))
  const session = { header: { cwd: workspace } }
  const exec = { agent: { session }, callId: 'call-3', signal: new AbortController().signal }
  const { restore } = stubFetch()
  try {
    const value = await tool.execute({ prompt: '一只黑狗' }, exec)
    const blocks = tool.output.render({ prompt: '一只黑狗' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, /generate_image|Generated/)
    assert.equal(blocks[1].type, 'image')
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})
