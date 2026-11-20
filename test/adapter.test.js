import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSizeHint, SiliconFlowImageAdapter } from '../src/adapter.js'
import { DEFAULT_MODELS, mergeModels, ROUTE } from '../src/catalog.js'
import { ParamStore } from '../src/params.js'
import { fakeResponse, pngBytes } from './helpers.js'

/** Install a fetch stub; returns the recorded calls and a restore function. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init, calls.length)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

/** Build a plugin context with credential + attachment doubles. */
function fakeCtx({ attachments = true } = {}) {
  const saved = []
  const read = []
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return { async resolve() { return { value: 'sk-test', source: 'file' } } }
      }
      if (name === 'attachments' && attachments) {
        return {
          async saveImage(input) {
            saved.push(input)
            return {
              attachmentId: `att-${saved.length}`,
              mediaType: input.mediaType,
              bytes: input.data.byteLength,
              width: 1024,
              height: 768,
              name: input.name,
            }
          },
          async readImage(ref) {
            read.push(ref)
            return { ref, data: pngBytes(64, 48) }
          },
        }
      }
      return undefined
    },
  }
  return { ctx, saved, read }
}

function adapterFor(ctx, config = {}, paramStore) {
  return new SiliconFlowImageAdapter({
    ctx,
    paramStore,
    config: {
      baseURL: 'https://api.siliconflow.cn/v1',
      watermark: false,
      timeoutMs: 180_000,
      providerName: 'SiliconFlow 生图',
      ...config,
    },
    models: mergeModels(undefined),
  })
}

async function collect(iterable) {
  const chunks = []
  for await (const chunk of iterable) chunks.push(chunk)
  return chunks
}

test('provider metadata describes the route and its catalog', async () => {
  const adapter = adapterFor(fakeCtx().ctx)
  assert.deepEqual(adapter.providerInfo(ROUTE), { id: ROUTE, name: 'SiliconFlow 生图' })
  assert.equal(adapter.imageRequestPricing(), undefined)
  assert.equal(adapter.providerRetryPolicy().retryableCodes.includes('RATE_LIMIT'), true)
  const models = await adapter.listModels(ROUTE)
  assert.equal(models.length, DEFAULT_MODELS.length)
  assert.ok(models.every((model) => model.provider === ROUTE))
  const resolved = await adapter.resolveModel(ROUTE, 'Qwen/Qwen-Image')
  assert.equal(resolved.id, 'Qwen/Qwen-Image')
  assert.equal(resolved.provider, ROUTE)
  assert.deepEqual(resolved.inputModalities, ['text'])
})

test('stream generates an image and emits text + image + finish chunks', async () => {
  const { ctx, saved } = fakeCtx()
  const adapter = adapterFor(ctx)
  const png = pngBytes(1024, 1024)
  const { calls, restore } = stubFetch((url) => {
    if (url.includes('/images/generations')) {
      return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }], seed: 42 } })
    }
    return fakeResponse({ bytes: png, contentType: 'image/png' })
  })
  try {
    const chunks = await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'system prompt' }] },
        { role: 'user', content: [{ type: 'text', text: '一只红苹果，白色背景' }] },
      ],
    }))

    assert.equal(calls.length, 2)
    const generation = calls[0]
    assert.match(generation.url, /\/images\/generations$/)
    assert.equal(generation.init.headers.authorization, 'Bearer sk-test')
    assert.equal(generation.init.headers['x-enable-watermark'], '0')
    const body = JSON.parse(generation.init.body)
    assert.equal(body.model, 'Kwai-Kolors/Kolors')
    assert.equal(body.prompt, '一只红苹果，白色背景')
    assert.equal(body.image_size, '1024x1024')
    assert.equal(body.guidance_scale, 7.5)

    assert.equal(saved.length, 1)
    assert.equal(saved[0].mediaType, 'image/png')
    assert.equal(saved[0].data.byteLength, png.byteLength)

    const kinds = chunks.map((chunk) => chunk.type)
    assert.deepEqual(kinds, ['block-start', 'text-delta', 'block-end', 'block-start', 'block-end', 'usage', 'finish'])
    const imageBlock = chunks[4].block
    assert.equal(imageBlock.type, 'image')
    assert.equal(imageBlock.attachment.attachmentId, 'att-1')
    assert.equal(imageBlock.offloaded, true, 'assistant images are excluded from later provider requests')
    assert.equal(chunks[5].usage.inputTokens, 0)
    assert.deepEqual(chunks[6].reason, { kind: 'stop' })
  } finally {
    restore()
  }
})

test('purpose calls never generate an image', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch(() => fakeResponse({ body: {} }))
  try {
    const chunks = await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      purpose: 'session-title',
      messages: [{ role: 'user', content: [{ type: 'text', text: '一只猫' }] }],
    }))
    assert.equal(calls.length, 0)
    assert.equal(chunks[1].text, '图像生成')
    assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })

    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      purpose: 'compaction',
      messages: [{ role: 'user', content: [{ type: 'text', text: '历史' }] }],
    }))
    assert.equal(calls.length, 0)
  } finally {
    restore()
  }
})

test('a size hint in the prompt overrides the catalog default', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch((url) =>
    url.includes('/images/generations')
      ? fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
      : fakeResponse({ bytes: pngBytes(), contentType: 'image/png' }),
  )
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Qwen/Qwen-Image',
      messages: [{ role: 'user', content: [{ type: 'text', text: '画一张海报 928x1664' }] }],
    }))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image_size, '928x1664')
    assert.equal(body.cfg, 4)
  } finally {
    restore()
  }
})

test('edit models forward reference images as data URLs and omit image_size', async () => {
  const { ctx, read } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch((url) =>
    url.includes('/images/generations')
      ? fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
      : fakeResponse({ bytes: pngBytes(), contentType: 'image/png' }),
  )
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Qwen/Qwen-Image-Edit-2509',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '把背景换成夜空' },
          { type: 'image', attachment: { attachmentId: 'in-1' } },
        ],
      }],
    }))
    assert.equal(read.length, 1)
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image, 'data:image/png;base64,' + Buffer.from(pngBytes(64, 48)).toString('base64'))
    assert.equal(body.image_size, undefined)
  } finally {
    restore()
  }
})

test('edit models require a reference image', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  await assert.rejects(
    () => collect(adapter.stream({
      provider: ROUTE,
      model: 'Qwen/Qwen-Image-Edit-2509',
      messages: [{ role: 'user', content: [{ type: 'text', text: '改一下' }] }],
    })),
    /edits existing images; attach one to three reference images/,
  )
})

test('a message without prompt text fails with a clear error', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  await assert.rejects(
    () => collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      messages: [{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'x' } }] }],
    })),
    /contains no prompt text/,
  )
})

test('provider HTTP errors keep their routable code', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { restore } = stubFetch(() => fakeResponse({
    ok: false,
    status: 429,
    body: { message: 'rate limiting', code: 30001 },
  }))
  try {
    await assert.rejects(
      () => collect(adapter.stream({
        provider: ROUTE,
        model: 'Kwai-Kolors/Kolors',
        messages: [{ role: 'user', content: [{ type: 'text', text: '猫' }] }],
      })),
      (error) => {
        assert.equal(error.code, 'RATE_LIMIT')
        assert.match(error.message, /HTTP 429.*rate limiting/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('parseSizeHint takes the last sane hint', () => {
  assert.deepEqual(parseSizeHint('cat 1024x1024 then 928x1664'), { width: 928, height: 1664 })
  assert.equal(parseSizeHint('no size here'), undefined)
  assert.equal(parseSizeHint('huge 5000x5000'), undefined)
})
test('plugin-authored user messages never become the prompt', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch((url) =>
    url.includes('/images/generations')
      ? fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
      : fakeResponse({ bytes: pngBytes(), contentType: 'image/png' }),
  )
  try {
    const chunks = await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      messages: [
        { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '画一只戴墨镜的橘猫' }] },
        { role: 'assistant', content: [{ type: 'text', text: '好' }] },
        { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1, step 1: 2026-11-12T18:05:43+08:00' }] },
      ],
    }))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.prompt, '画一只戴墨镜的橘猫')
    const captionChunk = chunks[1]
    assert.match(captionChunk.text, /戴墨镜的橘猫/)
    assert.doesNotMatch(captionChunk.text, /Time sampled/)
  } finally {
    restore()
  }
})

test('edit models cap reference images per model (Edit-2509: 3, Edit: 1)', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch((url) =>
    url.includes('/images/generations')
      ? fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
      : fakeResponse({ bytes: pngBytes(), contentType: 'image/png' }),
  )
  try {
    const threeImages = {
      role: 'user',
      content: [
        { type: 'text', text: '合成' },
        ...['a', 'b', 'c'].map((attachmentId) => ({ type: 'image', attachment: { attachmentId } })),
      ],
    }
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Qwen/Qwen-Image-Edit-2509',
      messages: [threeImages],
    }))
    let body = JSON.parse(calls[0].init.body)
    assert.equal(body.image2.startsWith('data:image/png;base64,'), true)
    assert.equal(body.image3.startsWith('data:image/png;base64,'), true)

    calls.length = 0
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Qwen/Qwen-Image-Edit',
      messages: [threeImages],
    }))
    body = JSON.parse(calls[0].init.body)
    assert.equal(body.image.startsWith('data:image/png;base64,'), true)
    assert.equal(body.image2, undefined, 'Qwen-Image-Edit takes exactly one reference image')
    assert.equal(body.image3, undefined)
  } finally {
    restore()
  }
})

test('panel parameters fill the request body for the session', async () => {
  const { ctx } = fakeCtx()
  const store = new ParamStore({})
  await store.set('sess-1', { image_size: '1216x832', num_inference_steps: 12, seed: 777, negative_prompt: '文字' })
  const adapter = adapterFor(ctx, {}, store)
  const png = pngBytes(1216, 832)
  const { calls, restore } = stubFetch((url) => {
    if (url.includes('/images/generations')) return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
    return fakeResponse({ bytes: png, contentType: 'image/png' })
  })
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '一片森林' }] }],
    }))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image_size, '1216x832', 'the panel size beats the model default')
    assert.equal(body.num_inference_steps, 12)
    assert.equal(body.seed, 777)
    assert.equal(body.negative_prompt, '文字')
    // A model-only default still rides along untouched.
    assert.equal(body.guidance_scale, 7.5)
  } finally {
    restore()
  }
})

test('a size hint in the prompt still beats the panel size', async () => {
  const { ctx } = fakeCtx()
  const store = new ParamStore({})
  await store.set('sess-1', { image_size: '1216x832' })
  const adapter = adapterFor(ctx, {}, store)
  const { calls, restore } = stubFetch((url) => {
    if (url.includes('/images/generations')) return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
    return fakeResponse({ bytes: pngBytes(512, 512), contentType: 'image/png' })
  })
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'Kwai-Kolors/Kolors',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '画个 512x512 的图标' }] }],
    }))
    assert.equal(JSON.parse(calls[0].init.body).image_size, '512x512')
  } finally {
    restore()
  }
})

test('parameters set for another model are dropped, not sent', async () => {
  const { ctx } = fakeCtx()
  const store = new ParamStore({})
  // 90 steps and a Qwen-only square are invalid for MOSS-Image.
  await store.set('sess-1', { image_size: '1328x1328', num_inference_steps: 90, seed: 5 })
  const adapter = adapterFor(ctx, {}, store)
  const { calls, restore } = stubFetch((url) => {
    if (url.includes('/images/generations')) return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
    return fakeResponse({ bytes: pngBytes(1024, 1024), contentType: 'image/png' })
  })
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'OpenMOSS-Team/MOSS-Image',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '一只猫' }] }],
    }))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image_size, '1024x1024', 'falls back to the model’s own default')
    assert.equal(body.num_inference_steps, 40, 'falls back to the model’s declared default')
    assert.equal(body.seed, 5, 'the model-neutral seed still applies')
  } finally {
    restore()
  }
})

test('without a store the request body keeps the catalog defaults', async () => {
  const { ctx } = fakeCtx()
  const adapter = adapterFor(ctx)
  const { calls, restore } = stubFetch((url) => {
    if (url.includes('/images/generations')) return fakeResponse({ body: { images: [{ url: 'https://s3.example/out.png' }] } })
    return fakeResponse({ bytes: pngBytes(1024, 1024), contentType: 'image/png' })
  })
  try {
    await collect(adapter.stream({
      provider: ROUTE,
      model: 'OpenMOSS-Team/MOSS-Image',
      sessionId: 'sess-1',
      messages: [{ role: 'user', content: [{ type: 'text', text: '一只猫' }] }],
    }))
    const body = JSON.parse(calls[0].init.body)
    assert.equal(body.image_size, '1024x1024')
    assert.equal(body.num_inference_steps, 40, 'MOSS-Image defaults to 40 steps')
  } finally {
    restore()
  }
})
