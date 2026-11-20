/**
 * `LLMAdapter` implementation that routes a SiliconFlow image-generation model
 * as a selectable model: the last user message's text is the prompt, and the
 * completion is one text caption plus the generated image(s) as durable image
 * blocks. The chat UI renders assistant image blocks through its
 * `conversation.message.images` slot, so selecting the model and asking for a
 * picture produces the picture in the conversation.
 *
 * Structural adapter: no harness package imports, so the plugin loads without
 * a dependency on the dsh installation's package layout.
 *
 * @module dsh-siliconflow-image/adapter
 */

import { downloadImage, imageDimensions, requestImages, resolveApiKey, sniffMediaType, toDataUrl } from './api.js'
import { modelEntry, modelInfo } from './catalog.js'
import { defaultStepsOf, normalizeParams, usableParams } from './params.js'

/** Zero token accounting: an image call consumes neither prompt nor output tokens. */
const ZERO_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0 })

/**
 * Concatenate the text blocks of one message's content.
 * @param {readonly object[]} content - message content blocks.
 * @returns {string} joined text.
 */
function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * The last human-authored user message in the request history. The loop also
 * injects plugin-authored user-role messages (time context, recall, notices),
 * which must never become the image prompt, so `source.kind` is filtered to
 * `user` (or absent for hand-built request inputs). Falls back to the last
 * user-role message when no human one is present.
 * @param {readonly object[]} messages - request messages.
 * @returns {object|undefined} last user message.
 */
function lastUserMessage(messages) {
  let fallback
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    fallback ??= message
    const kind = message.source?.kind
    if (kind === undefined || kind === 'user') return message
  }
  return fallback
}

/** A prompt may embed an explicit `1024x1024` size hint; the last one wins. */
const SIZE_HINT = /(?<!\d)(\d{2,4})\s*[x×]\s*(\d{2,4})(?!\d)/g

/**
 * Read one explicit `WIDTHxHEIGHT` hint from the prompt.
 * @param {string} prompt - user prompt.
 * @returns {{width: number, height: number}|undefined} size when the hint is sane.
 */
export function parseSizeHint(prompt) {
  let width
  let height
  for (const match of prompt.matchAll(SIZE_HINT)) {
    width = Number(match[1])
    height = Number(match[2])
  }
  if (!Number.isInteger(width) || !Number.isInteger(height)) return undefined
  if (width < 128 || height < 128 || width > 4096 || height > 4096) return undefined
  return { width, height }
}

/**
 * Short caption shown above the generated image and stored as assistant text.
 * @param {string} prompt - the prompt that produced the image.
 * @returns {string} caption.
 */
function caption(prompt) {
  const flat = prompt.replace(/\s+/g, ' ').trim()
  const cut = Array.from(flat)
  return cut.length > 160 ? `生成图片：${cut.slice(0, 160).join('')}…` : `生成图片：${flat}`
}

/**
 * One adapter instance owns exactly one provider route.
 */
export class SiliconFlowImageAdapter {
  /**
   * @param {object} options - adapter dependencies.
   * @param {object} options.ctx - plugin context (credential/attachment services are read per call).
   * @param {object} options.config - plugin config.
   * @param {object[]} options.models - effective catalog entries.
   */
  constructor({ ctx, config, models, paramStore }) {
    this.ctx = ctx
    this.config = config
    this.models = models
    /** Optional per-session parameter store filled by the composer panel. */
    this.paramStore = paramStore
  }

  /**
   * Describe the provider route.
   * @param {string} provider - route id passed to registerAdapter.
   * @returns {{id: string, name: string}} provider metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: this.config.providerName ?? 'SiliconFlow 生图' }
  }

  /**
   * Retry on transient failures. Image generation bills per successful image,
   * so only transport/server/rate-limit failures are retried.
   * @returns {object} resolved retry policy.
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 2,
      retryableCodes: ['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'],
      initialDelayMs: 2_000,
      maxDelayMs: 30_000,
      jitterRatio: 0.2,
    }
  }

  /**
   * No provider-side request-image pricing: image models here never receive
   * request images except as edit-model references, which are not billed as
   * visual tokens. The token meter then falls back to its neutral estimate.
   * @returns {undefined} no pricing declared.
   */
  imageRequestPricing() {
    return undefined
  }

  /**
   * Advertise the catalog to catalog-driven entry points (the model picker).
   * @param {string} provider - route id.
   * @returns {Promise<object[]>} discoverable models.
   */
  async listModels(provider) {
    return this.models.map((entry) => ({ provider, ...modelInfo(entry) }))
  }

  /**
   * Resolve one exact model id.
   * @param {string} provider - route id.
   * @param {string} model - exact model id.
   * @returns {Promise<object>} exact model metadata.
   */
  async resolveModel(provider, model) {
    const entry = modelEntry(model, this.models)
    return {
      provider,
      ...modelInfo(entry),
      context: { contextWindow: 8192 },
      defaultMaxTokens: 1024,
    }
  }

  /**
   * Bind one generation to this adapter instance.
   * @param {string} provider - route id.
   * @param {string} model - exact model id.
   * @returns {Promise<{model: object, stream: (options: object) => AsyncIterable<object>}>} prepared call.
   */
  async prepareCall(provider, model) {
    const info = await this.resolveModel(provider, model)
    return { model: info, stream: (options) => this.stream(options) }
  }

  /**
   * Stream one image-generation call as harness chunks.
   * @param {object} options - assembled model request.
   * @returns {AsyncIterable<object>} chunk stream.
   */
  async *stream(options) {
    const entry = modelEntry(options.model, this.models)
    const prompt = textOf(lastUserMessage(options.messages)?.content)

    // Harness auxiliary calls (session title, compaction) must never spend an
    // image generation. Answer them with a short text-only completion.
    if (options.purpose === 'session-title' || options.purpose === 'compaction') {
      yield* this.textOnly(
        options.purpose === 'session-title' ? '图像生成' : '（图像生成模型：无可压缩的文本历史）',
        options.purpose === 'session-title' ? 'stop' : 'stop',
      )
      return
    }

    if (prompt.length === 0) throw new Error('generate: the last user message contains no prompt text; describe the image you want')
    // Never rethrow the raw abort reason: when the upstream watchdog fires it is
    // Node's DOMException ("The operation was aborted due to timeout"), which
    // hides which deadline was hit and offers no next step.
    if (options.signal?.aborted) {
      throw Object.assign(
        new Error(
          'SiliconFlow image generation was cancelled before it started ' +
            '(the upstream request was aborted); retry or raise the stream idle timeout',
        ),
        { code: 'TIMEOUT', cause: options.signal.reason, callerAborted: true },
      )
    }

    const apiKey = await resolveApiKey(this.ctx, this.config)
    const references = entry.kind === 'edit' ? await this.referenceImages(options, entry.maxReferences ?? 1) : []
    if (entry.kind === 'edit' && references.length === 0) {
      throw new Error(`generate: model "${entry.id}" edits existing images; attach one to three reference images to your message`)
    }

    const stored = this.storedParams(options.sessionId, entry)
    const body = this.buildBody(entry, prompt, references, stored)
    const response = await requestImages({
      apiKey,
      baseURL: this.config.baseURL,
      body,
      watermark: this.config.watermark,
      timeoutMs: this.config.timeoutMs,
      userAgent: attributionUserAgent(),
      signal: options.signal,
    })

    const attachments = this.attachments()
    if (attachments === undefined) throw new Error('generate: no attachment service is mounted, so generated images cannot be stored')

    const captionText = caption(prompt)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: captionText }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: captionText } }

    let index = 1
    for (const image of response.images) {
      const downloaded = await downloadImage(image.url, {
        signal: options.signal,
        timeoutMs: this.config.timeoutMs,
        userAgent: attributionUserAgent(),
      })
      const mediaType = sniffMediaType(downloaded.data) ?? downloaded.mediaType
      const ref = await attachments.saveImage({
        data: downloaded.data,
        mediaType,
        name: generatedName(entry.id, index - 1, mediaType),
      })
      yield { type: 'block-start', index, blockType: 'image' }
      // `offloaded: true` keeps the durable block (the chat UI still renders
      // it) while every provider request projects it to placeholder text.
      // Without this, a later turn on a text/vision model replays the
      // assistant image into that provider, and adapters reject images in
      // assistant messages (only user messages and tool results may carry
      // them). The image is an output, not context, so excluding it from
      // requests is also the correct token accounting.
      yield { type: 'block-end', index, block: { type: 'image', attachment: ref, offloaded: true } }
      index += 1
    }

    yield { type: 'usage', usage: { ...ZERO_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Emit a complete text-only assistant block and stop.
   * @param {string} text - visible text.
   * @returns {AsyncIterable<object>} chunk stream.
   */
  async *textOnly(text) {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { ...ZERO_USAGE } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /**
   * Read reference images from the last user message through the attachment
   * service and turn each into a data URL the API accepts.
   * @param {object} options - model request.
   * @param {number} max - per-model cap (`image2`/`image3` are Edit-2509-only).
   * @returns {Promise<string[]>} data URLs, at most `max`.
   */
  async referenceImages(options, max = 3) {
    const attachments = this.attachments()
    if (attachments === undefined) return []
    const message = lastUserMessage(options.messages)
    const blocks = Array.isArray(message?.content) ? message.content : []
    const urls = []
    for (const block of blocks) {
      if (block?.type !== 'image' || block.attachment === undefined) continue
      const stored = await attachments.readImage(block.attachment, options.signal)
      urls.push(toDataUrl(stored.data, block.attachment.mediaType ?? 'image/png'))
      if (urls.length >= max) break
    }
    return urls
  }

  /**
   * Assemble the provider request body.
   * @param {object} entry - catalog entry.
   * @param {string} prompt - user prompt.
   * @param {string[]} references - reference-image data URLs (edit models only).
   * @returns {object} request body.
   */
  buildBody(entry, prompt, references, stored = {}) {
    const body = { model: entry.id, prompt }
    const defaults = entry.defaults ?? {}
    if (entry.kind === 'edit') {
      // The Edit family rejects image_size; references ride image/image2/image3.
      body.image = references[0]
      if (references[1] !== undefined) body.image2 = references[1]
      if (references[2] !== undefined) body.image3 = references[2]
    } else {
      // Precedence: an explicit size hint in the prompt, then the panel's
      // stored size, then the model's recommended default.
      const hint = parseSizeHint(prompt)
      body.image_size =
        hint !== undefined ? `${hint.width}x${hint.height}` : stored.image_size ?? entry.size ?? '1024x1024'
    }
    // The panel's stored steps win over the catalog default; a model that
    // declares neither simply omits the field (the provider applies its own).
    const steps = stored.num_inference_steps ?? defaults.num_inference_steps ?? (entry.kind === 'edit' ? undefined : defaultStepsOf(entry))
    if (steps !== undefined) body.num_inference_steps = steps
    if (defaults.guidance_scale !== undefined) body.guidance_scale = defaults.guidance_scale
    if (defaults.cfg !== undefined) body.cfg = defaults.cfg
    const negative = stored.negative_prompt ?? defaults.negative_prompt
    if (typeof negative === 'string' && negative.length > 0) body.negative_prompt = negative
    if (stored.seed !== undefined) body.seed = stored.seed
    return body
  }

  /**
   * Read the composer panel's parameters for one request, dropping values the
   * target model cannot accept.
   * @param {string|undefined} sessionId - session identity from the request.
   * @param {object} entry - catalog entry.
   * @returns {object} usable parameters (empty without a store or a session).
   */
  storedParams(sessionId, entry) {
    if (this.paramStore === undefined) return {}
    return usableParams(this.paramStore.get(sessionId), entry)
  }

  /**
   * The optional attachment service.
   * @returns {object|undefined} attachment store.
   */
  attachments() {
    if (typeof this.ctx?.get !== 'function') return undefined
    return this.ctx.get('attachments')
  }
}

/**
 * Stable, filesystem-safe display name for one generated attachment.
 * @param {string} model - model id.
 * @param {number} index - zero-based image index.
 * @param {string} mediaType - declared media type.
 * @returns {string} display name.
 */
function generatedName(model, index, mediaType) {
  const slug = model.split('/').pop()?.replace(/[^\w.-]+/g, '-') ?? 'image'
  const extension = mediaType === 'image/jpeg' ? 'jpg' : (mediaType.split('/')[1] ?? 'png')
  return `${slug}-${Date.now()}-${index}.${extension}`
}

/**
 * Product attribution for outbound provider requests, mirroring the harness
 * convention (`product/version (+url)`) without importing the harness package.
 * @returns {string} User-Agent value.
 */
export function attributionUserAgent() {
  return 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness) dsh-siliconflow-image'
}

export { imageDimensions }