import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { createParamsAdmin } from '../src/admin.js'
import { DEFAULT_MODELS, mergeModels } from '../src/catalog.js'
import { ParamStore } from '../src/params.js'

const models = mergeModels(undefined)

/**
 * One fake node:http response recorder.
 * @returns {object} response double with a settled-body accessor.
 */
function fakeResponse() {
  const state = { status: 200, headers: {}, body: undefined }
  return {
    state,
    headersSent: false,
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value
      this.headersSent = true
    },
    writeHead(status, headers) {
      state.status = status
      for (const [name, value] of Object.entries(headers ?? {})) state.headers[name.toLowerCase()] = value
      this.headersSent = true
    },
    end(body) {
      state.body = body
    },
    get json() {
      return JSON.parse(state.body)
    },
  }
}

/**
 * One fake GET request.
 * @param {string} url - request URL with query.
 * @returns {object} request double.
 */
function fakeGet(url) {
  return { method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }
}

/**
 * One fake POST request carrying a JSON body.
 * @param {string} url - request URL.
 * @param {unknown} body - JSON-serializable body.
 * @param {string} [address] - peer address.
 * @returns {object} request double (an async-iterable stream).
 */
function fakePost(url, body, address = '127.0.0.1') {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))])
  stream.method = 'POST'
  stream.url = url
  stream.headers = { 'content-type': 'application/json' }
  stream.socket = { remoteAddress: address }
  return stream
}

/**
 * Build a handler with a fresh in-memory store.
 * @returns {object} handler plus the store.
 */
function handler() {
  const paramStore = new ParamStore({})
  return {
    paramStore,
    handle: createParamsAdmin({ models, defaultModel: 'Kwai-Kolors/Kolors', paramStore }),
  }
}

test('GET returns the catalog facts the panel needs per model', async () => {
  const { handle } = handler()
  const res = fakeResponse()
  await handle(fakeGet('/api/siliconflow-image/params?sessionId=s1&model=OpenMOSS-Team/MOSS-Image'), res)
  const payload = res.json
  assert.equal(payload.defaultModel, 'Kwai-Kolors/Kolors')
  assert.equal(payload.selectedModel, 'OpenMOSS-Team/MOSS-Image')
  assert.equal(payload.models.length, DEFAULT_MODELS.length)
  const moss = payload.models.find((entry) => entry.id === 'OpenMOSS-Team/MOSS-Image')
  assert.equal(moss.sizes.length, 8)
  assert.equal(moss.maxSteps, 50)
  assert.equal(moss.defaultSteps, 40)
  assert.deepEqual(moss.sizes[0], { value: '1024x1024', ratio: '1:1' })
  assert.deepEqual(payload.params, {})
  assert.deepEqual(payload.fields, ['image_size', 'num_inference_steps', 'seed', 'negative_prompt'])

  // Edit entries advertise no sizes and their reference cap.
  const edit = payload.models.find((entry) => entry.id === 'Qwen/Qwen-Image-Edit-2509')
  assert.deepEqual(edit.sizes, [])
  assert.equal(edit.maxReferences, 3)
  assert.equal(edit.kind, 'edit')
})

test('POST stores validated parameters for the session', async () => {
  const { handle, paramStore } = handler()
  const res = fakeResponse()
  await handle(fakePost('/api/siliconflow-image/params', {
    sessionId: 's1',
    model: 'Kwai-Kolors/Kolors',
    params: { image_size: '1216x832', num_inference_steps: 12, seed: 7, negative_prompt: '文字' },
  }), res)
  assert.equal(res.state.status, 200)
  assert.equal(res.json.ok, true)
  assert.deepEqual(paramStore.get('s1'), { image_size: '1216x832', num_inference_steps: 12, seed: 7, negative_prompt: '文字' })

  // The next GET sees them.
  const read = fakeResponse()
  await handle(fakeGet('/api/siliconflow-image/params?sessionId=s1&model=Kwai-Kolors/Kolors'), read)
  assert.equal(read.json.params.num_inference_steps, 12)
})

test('POST refuses values the model cannot accept', async () => {
  const { handle, paramStore } = handler()
  const cases = [
    [{ image_size: '1328x1328' }, /accepts image_size/],
    [{ num_inference_steps: 51 }, /integer in \[1, 50\]/],
    [{ seed: -1 }, /integer in \[0, 9999999999\]/],
    [{ cfg: 4 }, /unknown image parameter/],
  ]
  for (const [params, pattern] of cases) {
    const res = fakeResponse()
    await handle(fakePost('/api/siliconflow-image/params', { sessionId: 's1', model: 'OpenMOSS-Team/MOSS-Image', params }), res)
    assert.equal(res.state.status, 400)
    assert.match(res.json.error.message, pattern)
  }
  assert.deepEqual(paramStore.get('s1'), {}, 'a rejected write stores nothing')
})

test('POST requires a session id and rejects non-loopback callers', async () => {
  const { handle } = handler()
  const missing = fakeResponse()
  await handle(fakePost('/api/siliconflow-image/params', { params: { seed: 1 } }), missing)
  assert.equal(missing.state.status, 400)
  assert.equal(missing.json.error.code, 'BAD_REQUEST')

  const remote = fakeResponse()
  await handle(fakeGet('/api/siliconflow-image/params?sessionId=s1'), remote)
  remote.state.status = 200
  const remoteReq = fakeGet('/api/siliconflow-image/params?sessionId=s1')
  remoteReq.socket.remoteAddress = '10.0.0.9'
  const blocked = fakeResponse()
  await handle(remoteReq, blocked)
  assert.equal(blocked.state.status, 403)
  assert.equal(blocked.json.error.code, 'FORBIDDEN')
})

test('an unsupported method is refused with an Allow header', async () => {
  const { handle } = handler()
  const res = fakeResponse()
  await handle({ method: 'DELETE', url: '/api/siliconflow-image/params', headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res)
  assert.equal(res.state.status, 405)
  assert.equal(res.state.headers.allow, 'GET, POST')
})
