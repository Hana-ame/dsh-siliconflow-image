import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASSISTANT_IMAGE_PROJECTION,
  createAssistantImageProjection,
  installAssistantImageProjection,
  needsProjection,
  projectAssistantImages,
} from '../src/projection.js'

/** One assistant message carrying a generated image. */
function assistantWithImage(seq = 7) {
  return {
    role: 'assistant',
    id: `msg-${seq}`,
    source: { kind: 'model', provider: 'siliconflow-image', model: 'Kwai-Kolors/Kolors' },
    content: [
      { type: 'text', text: '生成图片：猫' },
      { type: 'image', attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }, offloaded: true },
    ],
  }
}

test('only assistant messages with images need projection', () => {
  assert.equal(needsProjection(assistantWithImage()), true)
  assert.equal(needsProjection({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] }), false)
  assert.equal(needsProjection({ role: 'user', content: [{ type: 'image', attachment: {} }] }), false)
})

test('projectAssistantImages replaces image blocks and keeps identity shape', () => {
  const message = assistantWithImage()
  const projected = projectAssistantImages(message)
  assert.equal(projected.id, message.id)
  assert.equal(projected.role, 'assistant')
  assert.equal(projected.content[0].text, '生成图片：猫')
  assert.deepEqual(projected.content[1], {
    type: 'text',
    text: '[generated image att-9; shown to the user in the conversation]',
  })
  assert.equal(message.content[1].type, 'image', 'the input message is not mutated')
})

test('the projection rewrites exactly the targeted seq from its durable event', () => {
  const projection = createAssistantImageProjection()
  assert.equal(projection.type, ASSISTANT_IMAGE_PROJECTION)
  const target = assistantWithImage(7)
  const other = assistantWithImage(9)
  const events = [
    { type: 'assistant/message', seq: 7, data: { turn: 1, step: 1, message: target } },
    { type: 'step/end', seq: 8, data: {} },
    { type: 'assistant/message', seq: 9, data: { turn: 2, step: 1, message: other } },
  ]
  const changed = projection.project(
    { type: ASSISTANT_IMAGE_PROJECTION, seq: 20, data: { seq: 7 } },
    { nodes: [7, 9], events, baseSeq: 7, messages: new Map() },
  )
  assert.equal(changed.size, 1)
  assert.equal(changed.get(7).content[1].type, 'text')
  assert.equal(changed.has(9), false)
})

test('a message already rewritten by an earlier projection is the base', () => {
  const projection = createAssistantImageProjection()
  const target = assistantWithImage(7)
  const already = projectAssistantImages(target)
  const events = [{ type: 'assistant/message', seq: 7, data: { message: target } }]
  const changed = projection.project(
    { data: { seq: 7 } },
    { nodes: [7], events, baseSeq: 7, messages: new Map([[7, already]]) },
  )
  assert.equal(changed.size, 0, 'an already projected message is left alone')
})

test('invalid projection targets are rejected', () => {
  const projection = createAssistantImageProjection()
  const context = { nodes: [], events: [], baseSeq: 0, messages: new Map() }
  assert.throws(() => projection.project({ data: { seq: -1 } }, context), /non-negative integer/)
  assert.throws(() => projection.project({ data: { seq: 3 } }, context), /carries no model-visible message/)
  assert.throws(
    () => projection.project(
      { data: { seq: 3 } },
      { ...context, baseSeq: 3, events: [{ type: 'user/message', seq: 3, data: { message: { role: 'user', content: [] } } }] },
    ),
    /not an assistant message/,
  )
})

test('installer registers once per image-bearing assistant settlement', async () => {
  const registered = []
  const appends = []
  let listener
  const session = {
    append(type, data) {
      appends.push({ type, data })
      return { type, seq: 99, data }
    },
  }
  const ctx = {
    sessions: { registerMessageProjection: (projection) => registered.push(projection) },
    on: (name, callback) => {
      assert.equal(name, 'session/event')
      listener = callback
    },
  }
  installAssistantImageProjection(ctx)
  assert.equal(registered.length, 1)
  assert.equal(registered[0].type, ASSISTANT_IMAGE_PROJECTION)

  const message = assistantWithImage(7)
  listener(session, { type: 'assistant/message', seq: 7, data: { message } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(appends, [{ type: ASSISTANT_IMAGE_PROJECTION, data: { seq: 7 } }])

  // Same message event observed twice must not append twice.
  listener(session, { type: 'assistant/message', seq: 7, data: { message } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appends.length, 1)

  // Other events, plain assistant messages, and other providers are ignored.
  listener(session, { type: 'user/message', seq: 8, data: {} })
  listener(session, { type: 'assistant/message', seq: 9, data: { message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } } })
  listener(session, {
    type: 'assistant/message',
    seq: 10,
    data: { message: { ...assistantWithImage(10), source: { kind: 'model', provider: 'other', model: 'm' } } },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(appends.length, 1)
})