/**
 * dsh-siliconflow-image — Host half.
 *
 * Makes DSH speak SiliconFlow's image-generation models in two ways, sharing
 * one catalog and one API client:
 *
 *  1. Provider route `siliconflow-image`: every image model in the catalog is
 *     selectable in the model picker. Selecting one and asking for a picture
 *     produces an assistant message whose image block the chat UI renders.
 *  2. Tool `generate_image`: callable from any chat model, writes the image
 *     into the session workspace, and announces it as a deliverable.
 *
 * Credential: the harness credential store's `SILICONFLOW_API_KEY` reference
 * (Models settings / `.credentials.yaml`), then the same-named environment
 * variable, then a literal `apiKey` in the plugin config.
 *
 * @module dsh-siliconflow-image
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SiliconFlowImageAdapter } from './src/adapter.js'
import { createParamsAdmin } from './src/admin.js'
import { ParamStore } from './src/params.js'
import { mergeModels, ROUTE } from './src/catalog.js'
import { installAssistantImageProjection } from './src/projection.js'
import { createGenerateImageTool } from './src/tool.js'

export const name = 'siliconflow-image'

/** Services the plugin cannot work without: LLM registry, tool registry, session store. */
export const inject = ['llm', 'tools', 'sessions']

const DEFAULTS = {
  /** Base URL of the SiliconFlow OpenAI-compatible API. */
  baseURL: 'https://api.siliconflow.cn/v1',
  /** Credential-reference name resolved through `ctx.credentials` / the environment. */
  apiKeyRef: 'SILICONFLOW_API_KEY',
  /** Literal key fallback; prefer `apiKeyRef`. */
  apiKey: undefined,
  /** Model used by `generate_image` when the call names none. */
  defaultModel: 'OpenMOSS-Team/MOSS-Image',
  /** Workspace-relative directory for files written by `generate_image`. */
  outputDir: 'generated-images',
  /** `true` keeps SiliconFlow's visible "AI generated" watermark. */
  watermark: false,
  /** Per-request budget for generation + image download. */
  timeoutMs: 600_000,
  /** Human-readable provider name in the model picker. */
  providerName: 'SiliconFlow 生图',
  /** Catalog overrides; see `src/catalog.js`. */
  models: undefined,
  /** Composer image panel: expose the size/steps/seed/negative-prompt form. @default true */
  parameterPanel: true,
  /** Where the panel's per-session parameters persist; relative paths resolve beside this package. */
  paramsFile: '.siliconflow-image-params.json',
}

/**
 * Merge row config over defaults.
 * @param {object} config - loader row config.
 * @returns {object} effective config.
 */
function normalizeConfig(config) {
  const source = config && typeof config === 'object' ? config : {}
  const effective = { ...DEFAULTS, ...source }
  if (typeof effective.baseURL !== 'string' || effective.baseURL.trim().length === 0) {
    throw new Error('siliconflow-image: config.baseURL must be a non-empty string')
  }
  if (typeof effective.apiKeyRef !== 'string' || effective.apiKeyRef.length === 0) {
    throw new Error('siliconflow-image: config.apiKeyRef must name a credential reference')
  }
  if (!Number.isFinite(effective.timeoutMs) || effective.timeoutMs <= 0) {
    throw new Error('siliconflow-image: config.timeoutMs must be a positive number')
  }
  if (typeof effective.defaultModel !== 'string' || effective.defaultModel.length === 0) {
    throw new Error('siliconflow-image: config.defaultModel must be a non-empty model id')
  }
  if (typeof effective.outputDir !== 'string' || effective.outputDir.length === 0) {
    throw new Error('siliconflow-image: config.outputDir must be a non-empty path')
  }
  return effective
}

/**
 * Activate the plugin: one provider route plus one tool.
 * @param {object} ctx - Cordis plugin context.
 * @param {object} [config] - loader row config.
 * @returns {void}
 */
export function apply(ctx, config) {
  const effective = normalizeConfig(config)
  const models = mergeModels(effective.models)

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`siliconflow-image: ${message}`)
    } catch {
      /* logging is best-effort */
    }
  }

  const paramsFile =
    effective.parameterPanel === false
      ? undefined
      : path.isAbsolute(effective.paramsFile)
        ? effective.paramsFile
        : path.join(path.dirname(fileURLToPath(import.meta.url)), effective.paramsFile)
  const paramStore = new ParamStore({ filePath: paramsFile, warn })
  if (paramsFile !== undefined) {
    // Load eagerly so the first request already sees the persisted values.
    paramStore.load().catch((error) => warn(`could not load parameters: ${error?.message ?? error}`))
  }

  const adapter = new SiliconFlowImageAdapter({ ctx, config: effective, models, paramStore })

  try {
    ctx.llm.registerAdapter([ROUTE], adapter)
    ctx.logger?.info?.(`siliconflow-image: provider route "${ROUTE}" registered with ${models.length} image models`)
  } catch (error) {
    // A duplicate route or a failed registration must not take the tool down.
    warn(`could not register provider route "${ROUTE}": ${error?.message ?? error}`)
  }

  try {
    installAssistantImageProjection(ctx, ctx.logger)
    ctx.logger?.info?.('siliconflow-image: assistant-image request projection installed')
  } catch (error) {
    // Without the projection a mixed image-model + chat-model session fails on
    // replay; keep the image model and tool available but say so loudly.
    warn(`could not install the assistant-image projection: ${error?.message ?? error}`)
  }

  try {
    ctx.tools.register(createGenerateImageTool({ ctx, config: effective, paramStore }))
    ctx.logger?.info?.('siliconflow-image: tool "generate_image" registered')
  } catch (error) {
    warn(`could not register tool "generate_image": ${error?.message ?? error}`)
  }

  // The composer panel needs an HTTP seam: the browser cannot write Host
  // config, so it stores its four fields through this loopback route. A
  // headless composition simply has no `webServer` and stays route-free.
  if (effective.parameterPanel !== false) {
    try {
      const handler = createParamsAdmin({ models, defaultModel: effective.defaultModel, paramStore, warn })
      let mounted = false
      ctx.inject(['webServer'], (scoped) => {
        scoped.effect(
          () => scoped.webServer.register({ kind: 'prefix', path: '/api/siliconflow-image/params', handler }),
          'siliconflow-image: parameter panel admin',
        )
        mounted = true
        ctx.logger?.info?.('siliconflow-image: parameter panel admin mounted at /api/siliconflow-image/params')
      })
      if (!mounted) warn('webServer service is absent; the image parameter panel has no storage route')
    } catch (error) {
      warn(`could not mount the parameter panel route: ${error?.message ?? error}`)
    }
  }
}

export { ROUTE } from './src/catalog.js'
export { ASSISTANT_IMAGE_PROJECTION, installAssistantImageProjection } from './src/projection.js'