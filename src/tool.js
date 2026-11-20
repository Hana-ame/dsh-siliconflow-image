/**
 * `generate_image` tool: the model-facing bridge to the same SiliconFlow image
 * models the adapter exposes as a selectable provider. Works from any chat
 * model (text-only routes get a text summary; image-capable routes also
 * receive the image blocks), writes every generated image into the session
 * workspace, and announces the files as deliverables so the user gets file
 * cards.
 *
 * Registered by the profile-level host plugin, so every agent can call it.
 *
 * @module dsh-siliconflow-image/tool
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { downloadImage, imageDimensions, requestImages, resolveApiKey, sniffMediaType } from './api.js'
import { modelEntry, mergeModels } from './catalog.js'
import { assertSize, defaultStepsOf, MAX_SEED, maxStepsOf, MIN_STEPS, PARAM_KEYS, usableParams } from './params.js'

const TOOL_NAME = 'generate_image'

/** Date stamp used in generated file names: `20261112-174500`. */
function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-` +
    `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Filesystem-safe slug for one model id.
 * @param {string} model - model id.
 * @returns {string} slug.
 */
function slugOf(model) {
  return (model.split('/').pop() ?? 'image').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'image'
}

/**
 * Extension for a media type.
 * @param {string} mediaType - image media type.
 * @returns {string} extension without the dot.
 */
function extensionOfMedia(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg'
  return (mediaType.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png'
}

/**
 * Resolve a model-supplied output path against the session workspace.
 * @param {string} cwd - session working directory.
 * @param {string} authored - model-supplied path (may be absolute).
 * @returns {string} absolute path.
 */
function resolveOutputPath(cwd, authored) {
  return path.isAbsolute(authored) ? authored : path.resolve(cwd, authored)
}

/**
 * Build the tool definition.
 * @param {object} options - dependencies.
 * @param {object} options.ctx - plugin context.
 * @param {object} options.config - plugin config.
 * @returns {object} registry-ready tool definition.
 */
export function createGenerateImageTool({ ctx, config, paramStore }) {
  const models = mergeModels(config.models)

  return {
    name: TOOL_NAME,
    description:
      'Generate one or more images from a text prompt with a SiliconFlow image model (Kwai-Kolors, Qwen-Image, Z-Image, MOSS-Image, Qwen-Image-Edit). ' +
      'Saves every image into the session workspace and returns its absolute path. ALWAYS include each generated image in your reply as ![description](absolute-path) so the user sees it inline; a reply that only names the path is incomplete. ' +
      'For edit models, the current message must carry 1–3 reference images. ' +
      'Defaults for image_size / num_inference_steps / seed / negative_prompt come from the composer image panel when the user set them; explicit arguments here always win.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: {
          type: 'string',
          description: 'The image description. Be specific about subject, style, lighting, and composition; for text-bearing posters, quote the exact text and use size 1328x1328 with Qwen-Image.',
        },
        model: {
          type: 'string',
          description: `Image model id. Defaults to "${config.defaultModel ?? models[0]?.id ?? 'Kwai-Kolors/Kolors'}".`,
        },
        image_size: {
          type: 'string',
          description: 'Requested resolution as WIDTHxHEIGHT, e.g. "1024x1024", "1328x1328", "928x1664". Ignored by the Edit models. A size hint inside the prompt also works. Not every model accepts every size: MOSS-Image only accepts its eight ratio sizes, and Kolors/Qwen-Image/Z-Image use their own recommended sets.',
        },
        negative_prompt: {
          type: 'string',
          description: 'What should not appear in the image.',
        },
        seed: {
          type: 'integer',
          description: 'Random seed for reproducible generation (0–9999999999).',
        },
        num_inference_steps: {
          type: 'integer',
          description: 'Diffusion steps; higher is slower and usually better. The provider caps most models at 50 (Z-Image-Turbo accepts up to 100), so a value above the model’s cap is rejected before the request.',
        },
        guidance_scale: {
          type: 'number',
          description: 'Prompt-adherence scale for Kolors only (≤ 20, default 7.5).',
        },
        cfg: {
          type: 'number',
          description: 'CFG scale for Qwen-Image only (0.1–20; official configuration is 4.0).',
        },
        output_path: {
          type: 'string',
          description: 'Optional workspace-relative or absolute output path. Defaults to generated-images/<timestamp>-<model>.png.',
        },
        reference_images: {
          type: 'array',
          items: { type: 'string' },
          description: 'Edit models only: 1–3 reference images as public URLs or data:image/...;base64 URLs. Qwen-Image-Edit-2509 accepts up to three; Qwen-Image-Edit one.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['model', 'images'],
        properties: {
          model: { type: 'string' },
          prompt: { type: 'string' },
          seed: { type: 'integer' },
          traceId: { type: 'string' },
          inferenceSeconds: { type: 'number' },
          elapsedMs: { type: 'integer' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['path', 'mediaType', 'bytes'],
              properties: {
                path: { type: 'string' },
                mediaType: { type: 'string' },
                bytes: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
                attachment: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
                  properties: {
                    attachmentId: { type: 'string' },
                    mediaType: { type: 'string' },
                    bytes: { type: 'integer' },
                    width: { type: 'integer' },
                    height: { type: 'integer' },
                    name: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (args, value) => {
        const lines = value.images.map((image) => {
          const size = image.width !== undefined && image.height !== undefined ? `, ${image.width}x${image.height}px` : ''
          return `- ${image.path}${size}, ${image.bytes} bytes`
        })
        const blocks = [
          {
            type: 'text',
            text:
              `Generated ${value.images.length} image(s) with ${value.model}:\n` +
              lines.join('\n') +
              (typeof value.inferenceSeconds === 'number' ? `\nInference: ${value.inferenceSeconds}s` : '') +
              (typeof value.traceId === 'string' ? `\nTrace: ${value.traceId}` : '') +
              '\nInclude each image in your reply as ![description](<absolute path>) so the user sees it. You can also read it back with read_image.',
          },
        ]
        for (const image of value.images) {
          if (image.attachment !== undefined) blocks.push({ type: 'image', attachment: image.attachment })
        }
        return blocks
      },
      presentationMeta: (_args, value) => ({
        paths: value.images.map((image) => image.path),
        model: value.model,
      }),
    },
    async execute(args, exec) {
      const model = typeof args.model === 'string' && args.model.trim().length > 0
        ? args.model.trim()
        : config.defaultModel ?? models[0]?.id
      const entry = modelEntry(model, models)
      if (typeof args.prompt !== 'string' || args.prompt.trim().length === 0) throw new Error('prompt must be a non-empty string')
      if (exec.signal?.aborted) throw exec.signal.reason

      const apiKey = await resolveApiKey(ctx, config)
      const attachments = ctx.get('attachments')
      const references = Array.isArray(args.reference_images)
        ? args.reference_images.filter((url) => typeof url === 'string' && url.trim().length > 0)
        : []
      if (entry.kind === 'edit' && references.length === 0) {
        throw new Error(`model "${entry.id}" edits existing images; pass reference_images with 1–3 public image URLs or data URLs`)
      }

      // Panel parameters sit UNDER explicit arguments: the model named them in
      // this call, so they win; the panel only fills what it left out.
      const stored = usableParams(paramStore?.get(exec.agent?.session?.id), entry)

      const body = { model: entry.id, prompt: args.prompt.trim() }
      if (entry.kind === 'edit') {
        // The Edit family rejects `image_size`; passing it would 400 a paid call.
        if (args.image_size !== undefined) {
          throw new Error(`model "${entry.id}" does not accept image_size; it edits the reference image at its own resolution`)
        }
        // `image2`/`image3` are Edit-2509-only; Qwen-Image-Edit takes one input.
        const maxReferences = entry.maxReferences ?? 1
        if (references.length > maxReferences) {
          throw new Error(`model "${entry.id}" accepts at most ${maxReferences} reference image(s), got ${references.length}`)
        }
        body.image = references[0]
        if (references[1] !== undefined) body.image2 = references[1]
        if (references[2] !== undefined) body.image3 = references[2]
      } else {
        // `image_size` is required for every text-to-image model, and each
        // model accepts only its own set — the provider 400s otherwise.
        body.image_size = assertSize(
          entry.id,
          args.image_size ?? parseHint(args.prompt) ?? stored.image_size ?? entry.size ?? '1024x1024',
          entry,
        )
      }

      const defaults = entry.defaults ?? {}
      const steps = args.num_inference_steps ?? stored.num_inference_steps ?? defaults.num_inference_steps ?? defaultStepsOf(entry)
      if (steps !== undefined) body.num_inference_steps = integerInRange('num_inference_steps', steps, MIN_STEPS, maxStepsOf(entry))

      // Per the API doc, guidance_scale is Kolors-only and cfg is Qwen-Image-only.
      if (args.guidance_scale !== undefined && entry.id !== 'Kwai-Kolors/Kolors') {
        throw new Error('guidance_scale only applies to Kwai-Kolors/Kolors; omit it for this model')
      }
      if (args.cfg !== undefined && entry.id !== 'Qwen/Qwen-Image') {
        throw new Error('cfg only applies to Qwen/Qwen-Image; omit it for this model')
      }
      const guidance = args.guidance_scale ?? (entry.id === 'Kwai-Kolors/Kolors' ? defaults.guidance_scale : undefined)
      if (guidance !== undefined) body.guidance_scale = numberInRange('guidance_scale', guidance, 0, 20)
      const cfg = args.cfg ?? (entry.id === 'Qwen/Qwen-Image' ? defaults.cfg : undefined)
      if (cfg !== undefined) body.cfg = numberInRange('cfg', cfg, 0.1, 20)
      const seed = args.seed ?? stored.seed
      if (seed !== undefined) body.seed = integerInRange('seed', seed, 0, MAX_SEED)
      const negative = typeof args.negative_prompt === 'string' && args.negative_prompt.trim().length > 0
        ? args.negative_prompt.trim()
        : stored.negative_prompt
      if (typeof negative === 'string' && negative.length > 0) body.negative_prompt = negative

      const response = await requestImages({
        apiKey,
        baseURL: config.baseURL,
        body,
        watermark: config.watermark,
        timeoutMs: config.timeoutMs,
        userAgent: 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness) dsh-siliconflow-image',
        signal: exec.signal,
      })

      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
      const outputDir = resolveOutputPath(cwd, config.outputDir ?? 'generated-images')
      await mkdir(outputDir, { recursive: true })

      const stamp = timestamp()
      const images = []
      for (let index = 0; index < response.images.length; index += 1) {
        const downloaded = await downloadImage(response.images[index].url, {
          signal: exec.signal,
          timeoutMs: config.timeoutMs,
          userAgent: 'deepseek-harness/0.2.0-rc.2 (+https://github.com/deepseek-ai/deepseek-harness) dsh-siliconflow-image',
        })
        const mediaType = sniffMediaType(downloaded.data) ?? downloaded.mediaType
        const dimensions = imageDimensions(downloaded.data)
        const filename = `${stamp}-${slugOf(entry.id)}${index === 0 ? '' : `-${index + 1}`}.${extensionOfMedia(mediaType)}`
        const filePath =
          typeof args.output_path === 'string' && args.output_path.trim().length > 0
            ? resolveOutputPath(cwd, args.output_path.trim()) + (index === 0 ? '' : `-${index + 1}`)
            : path.join(outputDir, filename)
        await mkdir(path.dirname(filePath), { recursive: true })
        await writeFile(filePath, downloaded.data)
        const image = {
          path: filePath,
          mediaType,
          bytes: downloaded.data.byteLength,
          ...(dimensions === undefined ? {} : { width: dimensions.width, height: dimensions.height }),
        }
        if (attachments !== undefined) {
          try {
            const ref = await attachments.saveImage({
              data: downloaded.data,
              mediaType,
              name: path.basename(filePath),
            })
            image.attachment = {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
            }
          } catch {
            /* the file on disk is the deliverable; a failed attachment must not fail the call */
          }
        }
        images.push(image)
      }

      // Best-effort durable deliverable announcement: the same event the
      // `present` tool appends, so the user gets file cards for the images.
      announceDeliverables(exec, ctx, images)

      return {
        model: entry.id,
        prompt: args.prompt.trim(),
        ...(response.seed === undefined ? {} : { seed: response.seed }),
        ...(response.traceId === undefined ? {} : { traceId: response.traceId }),
        ...(response.inferenceSeconds === undefined ? {} : { inferenceSeconds: response.inferenceSeconds }),
        elapsedMs: response.elapsedMs,
        images,
      }
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `Generate image · ${args.model ?? config.defaultModel ?? models[0]?.id ?? 'image'}`,
        kind: 'other',
      }
    },
  }
}

/**
 * Validate an integer parameter against the API-documented range.
 * @param {string} name - parameter name for the error message.
 * @param {unknown} value - supplied value.
 * @param {number} min - inclusive minimum.
 * @param {number} max - inclusive maximum.
 * @returns {number} the validated integer.
 */
function integerInRange(name, value, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}], got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate a finite number parameter against the API-documented range.
 * @param {string} name - parameter name for the error message.
 * @param {unknown} value - supplied value.
 * @param {number} min - inclusive minimum.
 * @param {number} max - inclusive maximum.
 * @returns {number} the validated number.
 */
function numberInRange(name, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be a number in [${min}, ${max}], got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Validate one `WIDTHxHEIGHT` image size (the API documents sizes as model
 * recommendations, so the bound is a sanity fence rather than a whitelist).
 * @param {unknown} value - supplied size.
 * @param {boolean} explicit - whether the caller supplied it (stricter error text).
 * @returns {string} canonical `widthxheight`.
 */
function validateImageSize(value, explicit) {
  const text = typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(text)
  if (match === null) {
    throw new Error(`image_size must be formatted as WIDTHxHEIGHT, e.g. "1024x1024"${explicit ? `, got ${JSON.stringify(value)}` : ''}`)
  }
  const width = Number(match[1])
  const height = Number(match[2])
  if (width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new Error(`image_size ${text} is outside the supported sanity range 128..4096 per side`)
  }
  return `${width}x${height}`
}

/**
 * Read the last `WIDTHxHEIGHT` hint from a prompt.
 * @param {string} prompt - prompt text.
 * @returns {string|undefined} size hint.
 */
function parseHint(prompt) {
  let found
  for (const match of prompt.matchAll(/(?<!\d)(\d{2,4})\s*[x×]\s*(\d{2,4})(?!\d)/g)) {
    const width = Number(match[1])
    const height = Number(match[2])
    if (width >= 128 && height >= 128 && width <= 4096 && height <= 4096) found = `${width}x${height}`
  }
  return found
}

/**
 * Append the durable `deliverables/presented` event, mirroring the present tool.
 * @param {object} exec - tool execution context.
 * @param {object} ctx - plugin context.
 * @param {object[]} images - generated image metadata.
 */
function announceDeliverables(exec, ctx, images) {
  try {
    const session = exec.agent?.session
    if (session === undefined || typeof session.append !== 'function') return
    const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
    const boundary = projections?.stateOf?.(session, 'turnBoundary')
    if (boundary === undefined || boundary.openTurnStartSeq === null) return
    session.append('deliverables/presented', {
      turn: boundary.lastTurn,
      callId: exec.callId,
      files: images.map((image) => ({ path: image.path, description: `${image.width ?? '?'}x${image.height ?? '?'} ${image.mediaType}` })),
    })
  } catch {
    /* presentation is optional; never fail a paid generation for it */
  }
}

export { TOOL_NAME }