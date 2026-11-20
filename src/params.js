/**
 * Per-session image-generation parameters.
 *
 * The SiliconFlow playground exposes four fillable fields — Image Size,
 * Inference Steps, Seed, Negative Prompt. DSH's composer has no native image
 * form, so this module owns:
 *
 *  - the validation rules for those fields, derived from the *model catalog*
 *    (`sizes`, `maxSteps`, `defaultSteps`), because the provider rejects a
 *    size outside a per-model whitelist and clamps steps per model;
 *  - a small durable store keyed by session id, written by the loopback admin
 *    route the browser panel talks to and read by the adapter/tool at request
 *    time.
 *
 * An unset field means "use the model default": stored parameters are merged
 * *under* explicit call arguments, never over them.
 *
 * @module dsh-siliconflow-image/params
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SIZE_RATIOS } from './catalog.js'

/** Fields the panel may set. */
export const PARAM_KEYS = Object.freeze(['image_size', 'num_inference_steps', 'seed', 'negative_prompt'])

/** Largest seed the API documents (`seed <= 9999999999`). */
export const MAX_SEED = 9_999_999_999

/** Fallback step ceiling when a catalog entry declares none (provider caps most models at 50). */
export const FALLBACK_MAX_STEPS = 50

/** Provider-wide lower bound for `num_inference_steps`. */
export const MIN_STEPS = 1

/**
 * Playground ratio label for one `WIDTHxHEIGHT` size, e.g. `1216x832` → `3:2`.
 *
 * The catalog's `SIZE_RATIOS` table is authoritative because the provider's
 * labels are not exact fractions (`1472x1140` is called `4:3`), and a computed
 * gcd would print `13:19` for `832x1216` — a label no user recognises. The gcd
 * stays as the fallback for a size the table has not met yet.
 * @param {string} size - canonical size string.
 * @returns {string} ratio label.
 */
export function ratioLabel(size) {
  const text = String(size ?? '')
  const known = SIZE_RATIOS[text]
  if (known !== undefined) return known
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(text)
  if (match === null) return ''
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b))
  const width = Number(match[1])
  const height = Number(match[2])
  const divisor = gcd(width, height) || 1
  return `${width / divisor}:${height / divisor}`
}

/**
 * Size choices a model accepts, in catalog order.
 * @param {object} entry - catalog entry.
 * @returns {string[]} accepted sizes (`[]` for the Edit family, which rejects the field).
 */
export function sizesOf(entry) {
  if (!Array.isArray(entry?.sizes)) return []
  return entry.sizes.filter((size) => typeof size === 'string' && /^\d{2,4}x\d{2,4}$/.test(size))
}

/**
 * Step ceiling for one model.
 * @param {object} entry - catalog entry.
 * @returns {number} inclusive maximum.
 */
export function maxStepsOf(entry) {
  const declared = entry?.maxSteps
  return Number.isInteger(declared) && declared >= MIN_STEPS ? declared : FALLBACK_MAX_STEPS
}

/**
 * Default step count for one model (playground parity).
 * @param {object} entry - catalog entry.
 * @returns {number|undefined} default steps, when the catalog declares one.
 */
export function defaultStepsOf(entry) {
  const declared = entry?.defaultSteps ?? entry?.defaults?.num_inference_steps
  return Number.isInteger(declared) && declared >= MIN_STEPS ? declared : undefined
}

/**
 * Validate one size against the model's own whitelist.
 * @param {string} modelId - model id (for the error message).
 * @param {string} size - supplied `WIDTHxHEIGHT`.
 * @param {object} entry - catalog entry.
 * @returns {string} the accepted size.
 * @throws {Error} when the size is malformed or not offered by this model.
 */
export function assertSize(modelId, size, entry) {
  const allowed = sizesOf(entry)
  if (allowed.length === 0) {
    throw new Error(`${modelId} does not accept image_size; omit it (the model edits a reference image)`)
  }
  if (!allowed.includes(size)) {
    throw new Error(`${modelId} accepts image_size ${allowed.join(' / ')}, got ${JSON.stringify(size)}`)
  }
  return size
}

/**
 * Normalize one parameter bag against a model catalog entry.
 *
 * Absent keys stay absent (meaning "model default"); supplied keys are
 * validated, and unsupported keys are rejected instead of silently dropped, so
 * a paid request never runs with parameters the caller did not get.
 * @param {object} raw - untrusted parameter bag.
 * @param {object} entry - catalog entry the request targets.
 * @returns {object} normalized parameters (a fresh object).
 * @throws {Error} on an unknown key or an out-of-range value.
 */
export function normalizeParams(raw, entry) {
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('parameters must be an object')
  const normalized = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!PARAM_KEYS.includes(key)) throw new Error(`unknown image parameter "${key}"`)
    if (value === undefined || value === null || value === '') continue
    if (key === 'image_size') {
      if (typeof value !== 'string') throw new Error('image_size must be a string like "1024x1024"')
      normalized.image_size = assertSize(entry?.id ?? 'this model', value.trim(), entry)
    } else if (key === 'num_inference_steps') {
      const max = maxStepsOf(entry)
      if (!Number.isInteger(value) || value < MIN_STEPS || value > max) {
        throw new Error(`num_inference_steps must be an integer in [${MIN_STEPS}, ${max}], got ${JSON.stringify(value)}`)
      }
      normalized.num_inference_steps = value
    } else if (key === 'seed') {
      if (!Number.isInteger(value) || value < 0 || value > MAX_SEED) {
        throw new Error(`seed must be an integer in [0, ${MAX_SEED}], got ${JSON.stringify(value)}`)
      }
      normalized.seed = value
    } else {
      if (typeof value !== 'string') throw new Error('negative_prompt must be a string')
      const text = value.trim()
      if (text.length > 0) normalized.negative_prompt = text
    }
  }
  return normalized
}

/**
 * Merge stored parameters under explicit call values: an explicit value always
 * wins, and stored values the current model cannot accept are dropped rather
 * than failing a paid request (the user may have switched models after setting
 * them).
 * @param {object} stored - parameters from {@link ParamStore#get}.
 * @param {object} entry - catalog entry the request targets.
 * @returns {object} parameters safe to apply.
 */
export function usableParams(stored, entry) {
  if (stored === undefined || stored === null) return {}
  const out = {}
  const allowed = sizesOf(entry)
  if (typeof stored.image_size === 'string' && allowed.includes(stored.image_size)) out.image_size = stored.image_size
  if (Number.isInteger(stored.num_inference_steps) && stored.num_inference_steps >= MIN_STEPS && stored.num_inference_steps <= maxStepsOf(entry)) {
    out.num_inference_steps = stored.num_inference_steps
  }
  if (Number.isInteger(stored.seed) && stored.seed >= 0 && stored.seed <= MAX_SEED) out.seed = stored.seed
  if (typeof stored.negative_prompt === 'string' && stored.negative_prompt.trim().length > 0) {
    out.negative_prompt = stored.negative_prompt.trim()
  }
  return out
}

/**
 * Durable per-session parameter store.
 *
 * One small JSON document (`{version: 1, sessions: {sessionId: params}}`) is
 * written atomically on every change. Reads are served from memory; the file
 * exists so a DSH restart does not lose the panel's state.
 */
export class ParamStore {
  /**
   * @param {object} [options] - store options.
   * @param {string} [options.filePath] - JSON file backing the store; omit for memory-only.
   * @param {(message: string) => void} [options.warn] - best-effort diagnostics.
   */
  constructor({ filePath, warn } = {}) {
    this.filePath = filePath
    this.warn = warn
    /** @type {Map<string, object>} */
    this.sessions = new Map()
    this.loaded = false
    this.writing = Promise.resolve()
  }

  /**
   * Load the backing document once.
   * @returns {Promise<void>} completion.
   */
  async load() {
    if (this.loaded) return
    this.loaded = true
    if (this.filePath === undefined) return
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
      const sessions = parsed?.sessions
      if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
        for (const [sessionId, value] of Object.entries(sessions)) {
          if (value && typeof value === 'object' && !Array.isArray(value)) this.sessions.set(sessionId, { ...value })
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn?.(`could not read ${this.filePath}: ${error?.message ?? error}`)
    }
  }

  /**
   * Read one session's parameters.
   * @param {string|undefined} sessionId - session identity; `undefined` reads as empty.
   * @returns {object} stored parameters (never `undefined`).
   */
  get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return {}
    return this.sessions.get(sessionId) ?? {}
  }

  /**
   * Replace one session's parameters.
   * @param {string} sessionId - session identity.
   * @param {object} params - already-normalized parameters.
   * @returns {Promise<void>} completion of the durable write.
   */
  async set(sessionId, params) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId is required')
    if (Object.keys(params).length === 0) this.sessions.delete(sessionId)
    else this.sessions.set(sessionId, { ...params })
    await this.flush()
  }

  /**
   * Drop one session's parameters.
   * @param {string} sessionId - session identity.
   * @returns {Promise<void>} completion.
   */
  async clear(sessionId) {
    await this.set(sessionId, {})
  }

  /**
   * Serialize and atomically replace the backing document.
   * @returns {Promise<void>} completion.
   */
  flush() {
    if (this.filePath === undefined) return Promise.resolve()
    const write = async () => {
      const document = { version: 1, sessions: Object.fromEntries(this.sessions) }
      await mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
      await rename(temporary, this.filePath)
    }
    this.writing = this.writing.then(write, write)
    this.writing.catch((error) => this.warn?.(`could not save ${this.filePath}: ${error?.message ?? error}`))
    return this.writing
  }
}
