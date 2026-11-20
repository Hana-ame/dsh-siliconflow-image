import assert from 'node:assert/strict'
import test from 'node:test'
import {
  downloadImage,
  extensionOf,
  imageDimensions,
  requestImages,
  resolveApiKey,
  sniffMediaType,
  toDataUrl,
} from '../src/api.js'
import { pngBytes } from './helpers.js'

test('sniffMediaType reads PNG, JPEG, GIF magic bytes', () => {
  assert.equal(sniffMediaType(pngBytes()), 'image/png')
  assert.equal(sniffMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(sniffMediaType(new Uint8Array([...Buffer.from('GIF89a'), 1, 2])), 'image/gif')
  assert.equal(sniffMediaType(new Uint8Array([1, 2, 3])), undefined)
})

test('imageDimensions reads PNG IHDR dimensions', () => {
  assert.deepEqual(imageDimensions(pngBytes(1328, 928)), { width: 1328, height: 928 })
})

test('imageDimensions reads JPEG SOF dimensions', () => {
  // SOI + APP0 segment (length 4) + SOF0 segment with 17x11 dimensions.
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x0b, 0x00, 0x11, 0x01, 0x01, 0x11, 0x00,
  ])
  assert.deepEqual(imageDimensions(bytes), { width: 17, height: 11 })
})

test('extensionOf lowercases the file extension', () => {
  assert.equal(extensionOf('https://s3.example/a.PNG?x=1'), '.png')
  assert.equal(extensionOf('/tmp/noext'), '')
})

test('toDataUrl encodes image bytes', () => {
  assert.equal(toDataUrl(new Uint8Array([1, 2, 3]), 'image/png'), 'data:image/png;base64,AQID')
})

test('resolveApiKey prefers the credential store', async () => {
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve(ref) {
          assert.equal(ref, 'SILICONFLOW_API_KEY')
          return { value: ' from-credential ', source: 'file' }
        },
      }
    },
  }
  assert.equal(await resolveApiKey(ctx, {}), 'from-credential')
})

test('resolveApiKey falls back to the environment, then a literal key', async () => {
  const saved = process.env.SILICONFLOW_API_KEY
  process.env.SILICONFLOW_API_KEY = ' from-env '
  try {
    assert.equal(await resolveApiKey({ get: () => undefined }, {}), 'from-env')
  } finally {
    if (saved === undefined) delete process.env.SILICONFLOW_API_KEY
    else process.env.SILICONFLOW_API_KEY = saved
  }
  assert.equal(await resolveApiKey({ get: () => undefined }, { apiKey: ' literal ' }), 'literal')
})

test('resolveApiKey names the setting when nothing resolves', async () => {
  const saved = process.env.SILICONFLOW_API_KEY
  delete process.env.SILICONFLOW_API_KEY
  try {
    await assert.rejects(
      () => resolveApiKey({ get: () => ({ async resolve() { return undefined } }) }, { apiKeyRef: 'SILICONFLOW_API_KEY' }),
      /no SiliconFlow API key found.*SILICONFLOW_API_KEY/,
    )
  } finally {
    if (saved !== undefined) process.env.SILICONFLOW_API_KEY = saved
  }
})
/** Install a fetch stub and return recorded calls + restore. */
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test('requestImages sends a trace id and parses the documented timings', async () => {
  const { requestImages } = await import('../src/api.js')
  const { calls, restore } = stubFetch(() => ({
    ok: true,
    status: 200,
    headers: { get: (name) => (name.toLowerCase() === 'x-siliconcloud-trace-id' ? 'ti_trace_123' : null) },
    async json() {
      return { images: [{ url: 'https://s3.example/a.png' }], timings: { inference: 1.23 }, seed: 42 }
    },
    async text() { return '' },
  }))
  try {
    const result = await requestImages({
      apiKey: 'sk-test',
      body: { model: 'Kwai-Kolors/Kolors', prompt: 'cat', image_size: '1024x1024' },
    })
    assert.match(calls[0].init.headers['x-trace-id'], /^dsh-/)
    assert.equal(result.traceId, 'ti_trace_123')
    assert.equal(result.inferenceSeconds, 1.23)
    assert.equal(result.seed, 42)
  } finally {
    restore()
  }
})

test('requestImages failure carries the provider trace id', async () => {
  const { requestImages } = await import('../src/api.js')
  const { restore } = stubFetch(() => ({
    ok: false,
    status: 429,
    headers: { get: (name) => (name.toLowerCase() === 'x-siliconcloud-trace-id' ? 'ti_trace_err' : null) },
    async text() { return JSON.stringify({ message: 'rate limiting', code: 30001 }) },
    async json() { return {} },
  }))
  try {
    await assert.rejects(
      () => requestImages({ apiKey: 'sk-test', body: { model: 'x', prompt: 'y' } }),
      (error) => {
        assert.equal(error.traceId, 'ti_trace_err')
        assert.match(error.message, /trace ti_trace_err/)
        return true
      },
    )
  } finally {
    restore()
  }
})

test('a stalled request surfaces a routable TIMEOUT with the budget and trace', async () => {
  const original = globalThis.fetch
  // A fetch that rejects with the abort's own error name, exactly what the
  // global fetch does when `AbortSignal.timeout` fires mid-request.
  globalThis.fetch = (_url, init = {}) => {
    assert.ok(init.signal !== undefined, 'the client always arms a timeout signal')
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    return Promise.reject(error)
  }
  try {
    await assert.rejects(
      () => requestImages({ apiKey: 'sk-test', timeoutMs: 3000, body: { model: 'x', prompt: 'y' } }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT', 'routable code so the retry policy can act')
        assert.match(error.message, /timed out/)
        assert.match(error.message, /budget 3s/)
        assert.ok(typeof error.traceId === 'string' && error.traceId.startsWith('dsh-'))
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('the two abort sources are reported differently', async () => {
  const original = globalThis.fetch
  const abortLike = () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    return error
  }

  // A. The caller's signal aborted: our budget is NOT the limiting factor, so
  //    telling the user to raise config.timeoutMs would be wrong.
  const external = new AbortController()
  globalThis.fetch = () => {
    external.abort(abortLike())
    return Promise.reject(abortLike())
  }
  try {
    await assert.rejects(
      () => requestImages({ apiKey: 'k', signal: external.signal, timeoutMs: 600_000, body: { model: 'm', prompt: 'p' } }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT')
        assert.equal(error.callerAborted, true, 'flagged as an upstream cancellation')
        assert.match(error.message, /cancelled/)
        assert.match(error.message, /not by this plugin's 600s budget/)
        assert.match(error.message, /stream idle timeout/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }

  // B. Our own budget elapsed: raising config.timeoutMs is the right advice.
  globalThis.fetch = () => Promise.reject(abortLike())
  try {
    await assert.rejects(
      () => requestImages({ apiKey: 'k', timeoutMs: 5000, body: { model: 'm', prompt: 'p' } }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT')
        assert.equal(error.callerAborted, false)
        assert.match(error.message, /timed out/)
        assert.match(error.message, /budget 5s/)
        assert.match(error.message, /config\.timeoutMs/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('a cancelled or timed-out download never leaks the raw Node abort text', async () => {
  const original = globalThis.fetch
  const abortLike = () => {
    const error = new Error('The operation was aborted due to timeout')
    error.name = 'TimeoutError'
    return error
  }
  try {
    const external = new AbortController()
    globalThis.fetch = () => {
      external.abort()
      return Promise.reject(abortLike())
    }
    await assert.rejects(
      () => downloadImage('https://s3.example/x.png', { signal: external.signal, timeoutMs: 600_000 }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT')
        assert.equal(error.callerAborted, true)
        assert.match(error.message, /download was cancelled/)
        assert.doesNotMatch(error.message, /^The operation was aborted/)
        return true
      },
    )

    globalThis.fetch = () => Promise.reject(abortLike())
    await assert.rejects(
      () => downloadImage('https://s3.example/x.png', { timeoutMs: 7000 }),
      (error) => {
        assert.equal(error.code, 'TIMEOUT')
        assert.match(error.message, /download timed out after 7s/)
        assert.doesNotMatch(error.message, /^The operation was aborted/)
        return true
      },
    )
  } finally {
    globalThis.fetch = original
  }
})

test('the default request budget leaves room for the upstream watchdog', async () => {
  // A generation that queues past the harness stream idle timeout would be cut
  // off by the harness no matter what config.timeoutMs says. The documented
  // pairing is: plugin budget (600s) < upstream idle timeout (900s).
  const source = await import('node:fs/promises').then((m) => m.readFile(new URL('../src/api.js', import.meta.url), 'utf8'))
  const match = /const DEFAULT_TIMEOUT_MS = ([\d_]+)/.exec(source)
  assert.ok(match, 'the default budget is a named constant')
  const budget = Number(match[1].replaceAll('_', ''))
  assert.ok(budget >= 600_000, `budget grew past the old 300s (got ${budget})`)
  assert.ok(budget < 900_000, 'and stays below the 900s upstream idle timeout, so our message wins')
})
