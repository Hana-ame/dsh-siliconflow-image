/**
 * Loopback admin route for the composer image panel.
 *
 * The browser cannot write a Host plugin's config, so the panel talks to this
 * route instead:
 *
 *   GET  /api/siliconflow-image/params?sessionId=…   → catalog + stored params
 *   POST /api/siliconflow-image/params               → normalize + store
 *
 * Requests are restricted to loopback callers, like the other plugin admin
 * routes in this profile. The route returns the *effective* catalog facts the
 * panel needs (accepted sizes, step cap, defaults), so the form and the
 * request gate can never disagree.
 *
 * @module dsh-siliconflow-image/admin
 */

import { maxStepsOf, defaultStepsOf, normalizeParams, PARAM_KEYS, ratioLabel, sizesOf } from './params.js'

/** Largest accepted request body. The panel only sends four small fields. */
const MAX_BODY_BYTES = 64 * 1024

/**
 * Send one JSON response.
 * @param {object} res - node:http response.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 * @returns {void}
 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Reject one request with a machine-readable error.
 * @param {object} res - node:http response.
 * @param {number} status - HTTP status.
 * @param {string} message - human-readable message.
 * @param {string} code - stable machine code.
 * @returns {void}
 */
function sendError(res, status, message, code = 'BAD_REQUEST') {
  sendJson(res, status, { error: { message, code } })
}

/**
 * Read and JSON-parse one request body.
 * @param {object} req - node:http request.
 * @returns {Promise<object>} parsed object body.
 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 64 KiB')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed
}

/**
 * One request header as a plain string.
 * @param {object} req - node:http request.
 * @param {string} name - lower-case header name.
 * @returns {string|undefined} header value.
 */
function header(req, name) {
  const value = req.headers?.[name]
  return Array.isArray(value) ? value[0] : value
}

/**
 * Whether the request came from the same machine.
 * @param {object} req - node:http request.
 * @returns {boolean} loopback check.
 */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '')
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Project one catalog entry into the panel's model descriptor.
 * @param {object} entry - catalog entry.
 * @returns {object} wire descriptor.
 */
function describeModel(entry) {
  const sizes = sizesOf(entry)
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    kind: entry.kind === 'edit' ? 'edit' : 'generate',
    ...(entry.description ? { description: entry.description } : {}),
    size: entry.size ?? null,
    sizes: sizes.map((size) => ({ value: size, ratio: ratioLabel(size) })),
    maxSteps: maxStepsOf(entry),
    ...(defaultStepsOf(entry) === undefined ? {} : { defaultSteps: defaultStepsOf(entry) }),
    ...(entry.kind === 'edit' ? { maxReferences: entry.maxReferences ?? 1 } : {}),
  }
}

/**
 * Resolve one model id from the catalog, falling back to the default model.
 * @param {string|undefined} requested - requested id.
 * @param {object[]} models - effective catalog.
 * @param {string} defaultModel - configured default id.
 * @returns {object} catalog entry.
 */
function pickModel(requested, models, defaultModel) {
  const wanted = typeof requested === 'string' && requested.trim().length > 0 ? requested.trim() : defaultModel
  return models.find((entry) => entry.id === wanted) ?? models.find((entry) => entry.id === defaultModel) ?? models[0]
}

/**
 * Build the admin request handler.
 * @param {object} options - handler dependencies.
 * @param {object[]} options.models - effective catalog.
 * @param {string} options.defaultModel - configured default model id.
 * @param {import('./params.js').ParamStore} options.paramStore - per-session store.
 * @param {(message: string) => void} [options.warn] - best-effort diagnostics.
 * @returns {(req: object, res: object) => Promise<void>} route handler.
 */
export function createParamsAdmin({ models, defaultModel, paramStore, warn }) {
  return async function handle(req, res) {
    try {
      if (!isLoopback(req)) return sendError(res, 403, 'this route is loopback-only', 'FORBIDDEN')
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')

      if (req.method === 'GET') {
        await paramStore.load()
        const sessionId = url.searchParams.get('sessionId') ?? undefined
        const entry = pickModel(url.searchParams.get('model') ?? undefined, models, defaultModel)
        return sendJson(res, 200, {
          defaultModel,
          models: models.map(describeModel),
          selectedModel: entry.id,
          params: paramStore.get(sessionId),
          fields: PARAM_KEYS,
        })
      }

      if (req.method === 'POST') {
        await paramStore.load()
        const body = await readBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        if (sessionId.length === 0) return sendError(res, 400, 'sessionId is required', 'BAD_REQUEST')
        const entry = pickModel(body.model, models, defaultModel)
        let params
        try {
          params = normalizeParams(body.params, entry)
        } catch (error) {
          return sendError(res, 400, error?.message ?? String(error), 'INVALID_PARAMS')
        }
        await paramStore.set(sessionId, params)
        return sendJson(res, 200, { ok: true, model: entry.id, params })
      }

      res.setHeader('allow', 'GET, POST')
      return sendError(res, 405, 'method not allowed', 'METHOD_NOT_ALLOWED')
    } catch (error) {
      warn?.(`params admin: ${error?.message ?? error}`)
      if (!res.headersSent) sendError(res, 500, error?.message ?? 'internal error', 'INTERNAL')
      return undefined
    }
  }
}
