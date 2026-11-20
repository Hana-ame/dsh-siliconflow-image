import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createGenerateImageTool } from '../src/tool.js'
import { fakeResponse, pngBytes } from './helpers.js'

/** Build a plugin context with attachment + projection doubles. */
function fakeCtx({ attachments = true } = {}) {
  const saved = []
  const appended = []
  const ctx = {
    get(name) {
      if (name === 'credentials') return { async resolve() { return { value: 'sk-test', source: 'file' } } }
      if (name === 'attachments' && attachments) {
        return {
          async saveImage(input) {
            saved.push(input)
            return { attachmentId: 'att-1', mediaType: input.mediaType, bytes: input.data.byteLength, width: 1024, height: 768, name: input.name }
          },
        }
      }
      if (name === 'sessionProjections') {
        return {
          stateOf(session) {
            assert.equal(session, execFixture.agent.session)
            return { openTurnStartSeq: 1, lastTurn: 7 }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, saved, appended }
}

let execFixture

/** Build a tool-execution fixture over one temp workspace. */
async function fixture() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-siliconflow-image-'))
  const session = { header: { cwd: workspace }, append(type, data) { sessionAppends.push({ type, data }) } }
  const sessionAppends = []
  execFixture = { agent: { session }, callId: 'call-1', signal: new AbortController().signal }
  return { workspace, session, sessionAppends }
}

/** Install a fetch stub: generation returns one URL, download returns a PNG. */
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
  baseURL: 'https://api.siliconflow.cn/v1',
  outputDir: 'generated-images',
  defaultModel: 'Kwai-Kolors/Kolors',
  watermark: false,
  timeoutMs: 180_000,
  models: undefined,
}

test('writes the image into the workspace, attaches it, and returns metadata', async () => {
  const { ctx, saved } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch(pngBytes(1024, 768))
  try {
    const value = await tool.execute({ prompt: '一只红苹果' }, execFixture)
    assert.equal(value.model, 'Kwai-Kolors/Kolors')
    assert.equal(value.images.length, 1)
    const image = value.images[0]
    assert.ok(path.isAbsolute(image.path))
    assert.equal(path.dirname(image.path), path.join(workspace, 'generated-images'))
    assert.equal(image.mediaType, 'image/png')
    assert.deepEqual({ width: image.width, height: image.height }, { width: 1024, height: 768 })
    const onDisk = await readFile(image.path)
    assert.equal(onDisk.byteLength, pngBytes().byteLength)
    assert.equal(saved.length, 1)
    assert.equal(image.attachment.attachmentId, 'att-1')

    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.model, 'Kwai-Kolors/Kolors')
    assert.equal(body.prompt, '一只红苹果')
    assert.equal(body.image_size, '1024x1024')

    const blocks = tool.output.render({ prompt: '一只红苹果' }, value)
    assert.equal(blocks[0].type, 'text')
    assert.match(blocks[0].text, new RegExp(image.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(blocks[0].text, /!\[description\]\(<absolute path>\)/)
    assert.equal(blocks[1].type, 'image')
    assert.equal(blocks[1].attachment.attachmentId, 'att-1')
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('register the generated file as a deliverable', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace, sessionAppends } = await fixture()
  const { restore } = stubFetch()
  try {
    const value = await tool.execute({ prompt: '一只猫' }, execFixture)
    assert.equal(sessionAppends.length, 1)
    assert.equal(sessionAppends[0].type, 'deliverables/presented')
    assert.equal(sessionAppends[0].data.turn, 7)
    assert.equal(sessionAppends[0].data.callId, 'call-1')
    assert.equal(sessionAppends[0].data.files[0].path, value.images[0].path)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('honours an explicit output_path and model, and forwards sampling parameters', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch()
  try {
    const value = await tool.execute(
      { prompt: '海报 928x1664', model: 'Qwen/Qwen-Image', output_path: 'shots/poster.png', seed: 11 },
      execFixture,
    )
    assert.equal(value.model, 'Qwen/Qwen-Image')
    assert.equal(value.images[0].path, path.join(workspace, 'shots/poster.png'))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image_size, '928x1664')
    assert.equal(body.seed, 11)
    assert.equal(body.num_inference_steps, 50)
    assert.equal(body.cfg, 4)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('edit models require reference images', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch()
  try {
    await assert.rejects(
      () => tool.execute({ prompt: '换成夜空', model: 'Qwen/Qwen-Image-Edit-2509' }, execFixture),
      /edits existing images.*reference_images/,
    )
    assert.equal(calls.length, 0)
    const value = await tool.execute(
      {
        prompt: '换成夜空',
        model: 'Qwen/Qwen-Image-Edit-2509',
        reference_images: ['https://example.com/one.png', 'https://example.com/two.png'],
      },
      execFixture,
    )
    assert.equal(value.images.length, 1)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image, 'https://example.com/one.png')
    assert.equal(body.image2, 'https://example.com/two.png')
    assert.equal(body.image_size, undefined)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('surfaces provider failures with status and code', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const original = globalThis.fetch
  globalThis.fetch = async () => fakeResponse({ ok: false, status: 401, body: { message: 'Token is invalid.', code: 30014 } })
  try {
    await assert.rejects(
      () => tool.execute({ prompt: '猫' }, execFixture),
      (error) => {
        assert.equal(error.code, 'AUTH')
        assert.match(error.message, /HTTP 401.*Token is invalid/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
    await rm(workspace, { recursive: true, force: true })
  }
})

test('presentCall carries the requested model', () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const view = tool.presentCall({ prompt: '猫', model: 'Qwen/Qwen-Image' })
  assert.equal(view.card, 'generic')
  assert.match(view.title, /Qwen\/Qwen-Image/)
})
test('validates seed and step ranges against the model’s own caps', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch()
  try {
    await assert.rejects(() => tool.execute({ prompt: '猫', seed: -1 }, execFixture), /seed must be an integer in \[0, 9999999999\]/)
    await assert.rejects(() => tool.execute({ prompt: '猫', seed: 10_000_000_000 }, execFixture), /seed must be an integer/)
    // Most image models cap steps at 50 on the live service (the doc says 100).
    await assert.rejects(() => tool.execute({ prompt: '猫', num_inference_steps: 0 }, execFixture), /num_inference_steps must be an integer in \[1, 50\]/)
    await assert.rejects(() => tool.execute({ prompt: '猫', num_inference_steps: 51 }, execFixture), /num_inference_steps must be an integer in \[1, 50\]/)
    // Z-Image-Turbo accepts more steps than its siblings.
    await assert.rejects(
      () => tool.execute({ prompt: '猫', model: 'Tongyi-MAI/Z-Image-Turbo', num_inference_steps: 101 }, execFixture),
      /num_inference_steps must be an integer in \[1, 100\]/,
    )
    await assert.rejects(() => tool.execute({ prompt: '猫', guidance_scale: 7.5, model: 'Qwen/Qwen-Image' }, execFixture), /guidance_scale only applies to Kwai-Kolors\/Kolors/)
    await assert.rejects(() => tool.execute({ prompt: '猫', cfg: 4, model: 'Kwai-Kolors/Kolors' }, execFixture), /cfg only applies to Qwen\/Qwen-Image/)
    assert.equal(calls.length, 0, 'invalid arguments never reach the provider')
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('image_size is gated by the model’s own accepted set', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch()
  try {
    // A size no model offers is rejected, never sent.
    await assert.rejects(() => tool.execute({ prompt: '猫', image_size: 'big' }, execFixture), /accepts image_size/)
    // MOSS-Image only takes the eight ratio sizes.
    await assert.rejects(
      () => tool.execute({ prompt: '猫', model: 'OpenMOSS-Team/MOSS-Image', image_size: '1328x1328' }, execFixture),
      /MOSS-Image accepts image_size/,
    )
    // The Edit family rejects the field outright.
    await assert.rejects(
      () => tool.execute({ prompt: '改', model: 'Qwen/Qwen-Image-Edit', image_size: '1024x1024', reference_images: ['a'] }, execFixture),
      /does not accept image_size/,
    )
    assert.equal(calls.length, 0, 'invalid arguments never reach the provider')
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('edit models enforce the per-model reference-image limit', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const { calls, restore } = stubFetch()
  try {
    await assert.rejects(
      () => tool.execute({
        prompt: '改',
        model: 'Qwen/Qwen-Image-Edit-2509',
        reference_images: ['a', 'b', 'c', 'd'],
      }, execFixture),
      /at most 3 reference image\(s\)/,
    )
    await assert.rejects(
      () => tool.execute({
        prompt: '改',
        model: 'Qwen/Qwen-Image-Edit',
        reference_images: ['a', 'b'],
      }, execFixture),
      /at most 1 reference image\(s\)/,
    )
    assert.equal(calls.length, 0)
  } finally {
    restore()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('surfaces the documented trace id and inference timing', async () => {
  const { ctx } = fakeCtx()
  const tool = createGenerateImageTool({ ctx, config })
  const { workspace } = await fixture()
  const original = globalThis.fetch
  let call = 0
  globalThis.fetch = async () => {
    call += 1
    if (call === 1) {
      return fakeResponse({
        body: { images: [{ url: 'https://s3.example/out.png' }], timings: { inference: 2.5 }, seed: 3 },
        headers: { 'x-siliconcloud-trace-id': 'ti_abc' },
      })
    }
    return fakeResponse({ bytes: pngBytes(), contentType: 'image/png' })
  }
  try {
    const value = await tool.execute({ prompt: '猫' }, execFixture)
    assert.equal(value.traceId, 'ti_abc')
    assert.equal(value.inferenceSeconds, 2.5)
    assert.equal(value.seed, 3)
    const blocks = tool.output.render({ prompt: '猫' }, value)
    assert.match(blocks[0].text, /Inference: 2.5s/)
    assert.match(blocks[0].text, /Trace: ti_abc/)
  } finally {
    globalThis.fetch = original
    await rm(workspace, { recursive: true, force: true })
  }
})
