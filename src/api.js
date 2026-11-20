/**
 * Thin SiliconFlow image API client: credential resolution, `POST
 * /images/generations`, result download, and a PNG/JPEG dimension sniff.
 *
 * No SDK dependency: Node's global `fetch` is used, and the deployment's
 * `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` handling applies exactly as it does to
 * any other outbound request from the harness.
 *
 * @module dsh-siliconflow-image/api
 */

const DEFAULT_BASE_URL = 'https://api.siliconflow.cn/v1'
const DEFAULT_API_KEY_REF = 'SILICONFLOW_API_KEY'
const DEFAULT_TIMEOUT_MS = 600_000

/**
 * Resolve the API key through the harness credential seam, then the process
 * environment, then a literal config value. Resolution is per call so a
 * credential changed outside the process reaches the next request.
 * @param {object} ctx - plugin context carrying the optional `credentials` service.
 * @param {object} config - plugin config.
 * @returns {Promise<string>} trimmed non-empty key.
 */
export async function resolveApiKey(ctx, config) {
  const ref = typeof config.apiKeyRef === 'string' && config.apiKeyRef.length > 0
    ? config.apiKeyRef
    : DEFAULT_API_KEY_REF
  const credentials = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined && typeof hit.value === 'string' && hit.value.trim().length > 0) return hit.value.trim()
    } catch {
      /* fall through to env / literal */
    }
  }
  const fromEnv = process.env[ref]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  if (typeof config.apiKey === 'string' && config.apiKey.trim().length > 0) return config.apiKey.trim()
  throw new Error(
    `generate_image: no SiliconFlow API key found. Set ${ref} through the harness credential store (Models settings) ` +
      `or export ${ref} with the raw key from https://cloud.siliconflow.cn/account/ak`,
  )
}

/**
 * One SiliconFlow error response, normalized to a readable message.
 * @param {Response} response - failed HTTP response.
 * @returns {Promise<Error>} error carrying the status and provider message.
 */
async function requestError(response) {
  let detail = ''
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text)
      const message = parsed?.message ?? parsed?.error?.message ?? parsed?.data?.message
      const code = parsed?.code ?? parsed?.error?.code
      detail = [typeof code === 'number' || typeof code === 'string' ? `code ${code}` : '', message]
        .filter((part) => typeof part === 'string' && part.length > 0)
        .join(': ')
    } catch {
      detail = text
    }
  } catch {
    /* ignore body read failures */
  }
  const error = new Error(
    `SiliconFlow image request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
  )
  error.status = response.status
  error.code =
    response.status === 401 || response.status === 403
      ? 'AUTH'
      : response.status === 429
        ? 'RATE_LIMIT'
        : response.status >= 500
          ? 'SERVER'
          : 'INVALID_REQUEST'
  return error
}

/**
 * Merge a request signal with one total timeout.
 * @param {AbortSignal|undefined} signal - caller cancellation.
 * @param {number} timeoutMs - total budget.
 * @returns {AbortSignal} signal that aborts on either.
 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (signal === undefined) return timeout
  return AbortSignal.any([signal, timeout])
}

/**
 * Send one `images/generations` request.
 * @param {object} request - request options.
 * @returns {Promise<{images: {url: string}[], seed?: number, requestId?: string, elapsedMs: number}>} parsed response.
 */
export async function requestImages(request) {
  const {
    apiKey,
    baseURL = DEFAULT_BASE_URL,
    body,
    watermark = false,
    userAgent,
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = request
  const traceId = request.traceId ?? `dsh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  const headers = {
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    'user-agent': userAgent ?? 'deepseek-harness (dsh-siliconflow-image)',
    // Documented optional request-tracing header; the platform echoes it in
    // `x-siliconcloud-trace-id` and the generator logs the id for support.
    'x-trace-id': traceId,
  }
  if (watermark === false) headers['x-enable-watermark'] = '0'

  const started = Date.now()
  let response
  try {
    response = await fetch(`${baseURL.replace(/\/+$/, '')}/images/generations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (error) {
    // A provider that accepts the request and then stalls is a real failure the
    // caller must see as TIMEOUT (routable + retryable), not an opaque abort.
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      const elapsedMs = Date.now() - started
      // Two very different aborts land here:
      //  - OUR budget elapsed (`AbortSignal.timeout(timeoutMs)` inside
      //    withTimeout): nothing aborted the caller's signal, so raising
      //    config.timeoutMs actually helps;
      //  - the CALLER's signal aborted (the harness stream idle watchdog):
      //    our budget is irrelevant — the upper layer cut the wait short.
      // Say which one it was, or the user is told to raise a setting that is
      // not the limiting factor.
      const callerAborted = signal?.aborted === true
      const seconds = Math.round(elapsedMs / 1000)
      const message = callerAborted
        ? `SiliconFlow image generation was cancelled after ${seconds}s by the harness ` +
          `(not by this plugin's ${Math.round(timeoutMs / 1000)}s budget) — raise the ` +
          `upstream stream idle timeout to wait longer; trace ${traceId}`
        : `SiliconFlow image generation timed out after ${seconds}s ` +
          `(budget ${Math.round(timeoutMs / 1000)}s) — the generator may be queued; ` +
          `raise config.timeoutMs or retry; trace ${traceId}`
      throw Object.assign(new Error(message), {
        code: 'TIMEOUT',
        cause: error,
        traceId,
        elapsedMs,
        callerAborted,
      })
    }
    throw Object.assign(new Error(`SiliconFlow image request failed: ${error?.message ?? error}`), {
      code: 'TRANSPORT',
    })
  }
  const responseTraceId = response.headers.get('x-siliconcloud-trace-id') ?? traceId
  if (!response.ok) {
    const error = await requestError(response)
    error.traceId = responseTraceId
    error.message += ` [trace ${responseTraceId}]`
    throw error
  }
  const payload = await response.json()
  const images = Array.isArray(payload?.images) ? payload.images.filter((item) => typeof item?.url === 'string') : []
  if (images.length === 0) throw new Error(`SiliconFlow returned no image URLs [trace ${responseTraceId}]`)
  return {
    images,
    traceId: responseTraceId,
    ...(typeof payload?.seed === 'number' ? { seed: payload.seed } : {}),
    // Documented response field: `timings.inference` in seconds.
    ...(typeof payload?.timings?.inference === 'number' ? { inferenceSeconds: payload.timings.inference } : {}),
    elapsedMs: Date.now() - started,
  }
}

/** Media types an image URL may declare, by file extension. */
const EXTENSION_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/**
 * Download one generated image. Service URLs are signed S3 links valid for one
 * hour, so the bytes are fetched immediately and never re-fetched later.
 * @param {string} url - image URL from the provider response.
 * @param {object} [options] - download options.
 * @returns {Promise<{data: Uint8Array, mediaType: string}>} bytes and media type.
 */
export async function downloadImage(url, options = {}) {
  const { signal, timeoutMs = DEFAULT_TIMEOUT_MS, userAgent } = options
  let response
  try {
    response = await fetch(url, {
      signal: withTimeout(signal, timeoutMs),
      headers: userAgent ? { 'user-agent': userAgent } : undefined,
    })
  } catch (error) {
    // Same split as requestImages: a cancelled download must not surface the raw
    // Node "The operation was aborted due to timeout" text, which tells the user
    // nothing about which budget ran out.
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      const cancelled = signal?.aborted === true
      throw Object.assign(
        new Error(
          cancelled
            ? `generated image download was cancelled by the harness (not by this plugin's ${Math.round(timeoutMs / 1000)}s budget)`
            : `generated image download timed out after ${Math.round(timeoutMs / 1000)}s`,
        ),
        { code: 'TIMEOUT', cause: error, callerAborted: cancelled },
      )
    }
    throw Object.assign(new Error(`could not download generated image: ${error?.message ?? error}`), {
      code: 'TRANSPORT',
    })
  }
  if (!response.ok) throw await requestError(response)
  const data = new Uint8Array(await response.arrayBuffer())
  const contentType = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const declared = contentType.startsWith('image/') ? contentType : ''
  const guessed = EXTENSION_MEDIA_TYPES[extensionOf(new URL(url).pathname)] ?? ''
  const mediaType = declared || guessed || sniffMediaType(data) || 'image/png'
  return { data, mediaType }
}

/**
 * Lowercase file extension including the dot, or an empty string.
 * @param {string} pathOrUrl - path or URL pathname.
 * @returns {string} extension.
 */
export function extensionOf(pathOrUrl) {
  const withoutQuery = pathOrUrl.split(/[?#]/)[0]
  const name = withoutQuery.split(/[\\/]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot).toLowerCase()
}

/**
 * Identify a supported image media type from raw bytes.
 * @param {Uint8Array} data - encoded image bytes.
 * @returns {string|undefined} media type, or undefined when unrecognized.
 */
export function sniffMediaType(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) return 'image/webp'
  if (bytes.length >= 6 && (ascii(bytes, 0, 'GIF87a') || ascii(bytes, 0, 'GIF89a'))) return 'image/gif'
  return undefined
}

/**
 * Compare ASCII bytes at an offset.
 * @param {Uint8Array} bytes - source bytes.
 * @param {number} offset - start offset.
 * @param {string} text - expected ASCII text.
 * @returns {boolean} whether the bytes match.
 */
function ascii(bytes, offset, text) {
  if (bytes.length < offset + text.length) return false
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false
  }
  return true
}

/**
 * Intrinsic dimensions of a PNG, JPEG, or WebP image, read from headers only.
 * @param {Uint8Array} data - encoded image bytes.
 * @returns {{width: number, height: number}|undefined} dimensions when known.
 */
export function imageDimensions(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // PNG: 8-byte signature, then IHDR chunk (length, "IHDR", width, height).
  if (bytes.length >= 24 && bytes[0] === 0x89 && ascii(bytes, 1, 'PNG')) {
    return { width: view.getUint32(16), height: view.getUint32(20) }
  }
  // WebP: VP8 / VP8L / VP8X variants.
  if (bytes.length >= 30 && ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WEBP')) {
    const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15])
    if (chunk === 'VP8X') return { width: 1 + readUint24LE(bytes, 24), height: 1 + readUint24LE(bytes, 27) }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff }
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = view.getUint32(21, true)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
  }
  // JPEG: walk segments to the first Start-Of-Frame.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1
        continue
      }
      const marker = bytes[offset + 1]
      if (marker === undefined) break
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2
        continue
      }
      const length = view.getUint16(offset + 2)
      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      if (isSof && offset + 9 <= bytes.length) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
      }
      offset += 2 + length
    }
  }
  return undefined
}

/**
 * Little-endian 24-bit integer.
 * @param {Uint8Array} bytes - source bytes.
 * @param {number} offset - start offset.
 * @returns {number} value.
 */
function readUint24LE(bytes, offset) {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16)
}

/**
 * Encode image bytes as a `data:` URL for edit-model reference images.
 * @param {Uint8Array} data - image bytes.
 * @param {string} mediaType - declared media type.
 * @returns {string} data URL.
 */
export function toDataUrl(data, mediaType) {
  return `data:${mediaType};base64,${Buffer.from(data).toString('base64')}`
}

export { DEFAULT_BASE_URL, DEFAULT_API_KEY_REF, DEFAULT_TIMEOUT_MS }