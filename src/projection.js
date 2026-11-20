/**
 * Assistant-image request projection.
 *
 * The image model adapter emits the generated image as an assistant `image`
 * block so the chat UI renders it. The harness documents assistant-side image
 * blocks as forward compatibility, but the shipped text adapters reject images
 * in in-history assistant messages (`pi-ai cannot represent an image in an
 * in-history assistant message`, `UNSUPPORTED_CONTENT`), and
 * `projectOffloadedImages` runs after that role check. A mixed session —
 * generate with the image model, then continue with a chat model — would
 * therefore fail every later request.
 *
 * This module installs the durable, replayable fix: after one assistant
 * message carrying generated images lands, append a plugin-owned event; its
 * message projection rewrites that message's image occurrences to placeholder
 * text in the MODEL-VISIBLE history only. The durable log, the chat UI, and
 * the attachment store keep the block, so the image still displays, and the
 * token meter is unchanged (it reads original events).
 *
 * @module dsh-siliconflow-image/projection
 */

/** Plugin-owned event type carrying one `assistant/message` seq to project. */
export const ASSISTANT_IMAGE_PROJECTION = 'siliconflow-image/assistant-image-project'

/**
 * The placeholder that replaces one generated image in provider history.
 * @param {object} attachment - durable image reference.
 * @returns {string} model-visible stand-in.
 */
export function imagePlaceholder(attachment) {
  const id = typeof attachment?.attachmentId === 'string' ? attachment.attachmentId : 'unknown'
  return `[generated image ${id}; shown to the user in the conversation]`
}


/**
 * Read the durable assistant message carried by one event sequence.
 * @param {object} context - projection context (events window + base seq).
 * @param {number} seq - absolute event sequence.
 * @returns {object|undefined} the message, unless it is unavailable or was not a message event.
 */
function messageOfEvent(context, seq) {
  const baseSeq = context?.baseSeq ?? 0
  const event = context?.events?.[seq - baseSeq]
  if (event === undefined || event.seq !== seq) return undefined
  const data = event.data
  return data?.message
}

/**
 * Whether one message is an assistant turn carrying image blocks.
 * @param {object|undefined} message - derived session message.
 * @returns {boolean} whether the projection must rewrite it.
 */
export function needsProjection(message) {
  return message?.role === 'assistant' && Array.isArray(message.content) && message.content.some((block) => block?.type === 'image')
}

/**
 * Rewrite one assistant message's image blocks to placeholder text.
 * @param {object} message - assistant message to project.
 * @returns {object} immutable copy with text placeholders in image positions.
 */
export function projectAssistantImages(message) {
  return {
    ...message,
    content: message.content.map((block) => (block?.type === 'image' ? { type: 'text', text: imagePlaceholder(block.attachment) } : block)),
  }
}

/**
 * The session message projection definition for {@link ASSISTANT_IMAGE_PROJECTION}.
 * @returns {object} registry-ready projection.
 */
export function createAssistantImageProjection() {
  return {
    type: ASSISTANT_IMAGE_PROJECTION,
    /**
     * Validate the decision and return the rewritten messages.
     * @param {object} event - the plugin-owned projection event.
     * @param {object} context - surface history preceding the event.
     * @returns {Map<number, object>} changed messages keyed by original seq.
     */
    project(event, context) {
      const targetSeq = event?.data?.seq
      if (!Number.isInteger(targetSeq) || targetSeq < 0) throw new Error(`${ASSISTANT_IMAGE_PROJECTION}: data.seq must be a non-negative integer`)
      // `context.messages` holds only messages an earlier projection already
      // rewrote; derive the target from its durable event instead.
      const previous = context.messages.get(targetSeq)
      const original = previous ?? messageOfEvent(context, targetSeq)
      if (original === undefined) throw new Error(`${ASSISTANT_IMAGE_PROJECTION}: seq ${targetSeq} carries no model-visible message`)
      if (original.role !== 'assistant') throw new Error(`${ASSISTANT_IMAGE_PROJECTION}: seq ${targetSeq} is not an assistant message`)
      if (!needsProjection(original)) return new Map()
      return new Map([[targetSeq, projectAssistantImages(original)]])
    },
  }
}

/**
 * Observe assistant settlements and append the projection event once per
 * message. `session/event` observers run inside the append boundary, where a
 * re-entrant append throws, so the durable marker is deferred one microtask;
 * the turn's next request (a later turn in a mixed session) is built well after
 * that.
 * @param {object} ctx - plugin context carrying `sessions`.
 * @param {object} [logger] - optional warn sink.
 * @returns {void}
 */
export function installAssistantImageProjection(ctx, logger) {
  const used = new WeakSet()
  ctx.sessions.registerMessageProjection(createAssistantImageProjection())
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    const message = event.data?.message
    if (!needsProjection(message)) return
    const provider = message.source?.provider
    // Only this plugin's route emits assistant images today; restricting the
    // rewrite to it keeps the projection away from other adapters' content.
    if (provider !== undefined && provider !== 'siliconflow-image') return
    if (used.has(message)) return
    used.add(message)
    queueMicrotask(() => {
      try {
        session.append(ASSISTANT_IMAGE_PROJECTION, { seq: event.seq })
      } catch (error) {
        try {
          logger?.warn?.(`assistant-image projection skipped for seq ${event.seq}: ${error?.message ?? error}`)
        } catch {
          /* logging is best-effort */
        }
      }
    })
  })
}