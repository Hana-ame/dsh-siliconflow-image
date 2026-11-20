/**
 * SiliconFlow image-generation model catalog.
 *
 * The list is a snapshot of `GET https://api.siliconflow.cn/v1/models`
 * (2026-11-12, 97 models) filtered to the image-generation entries plus the
 * per-model recommended `image_size` values documented in
 * https://api-docs.siliconflow.cn/docs/api/images-generations-post.
 *
 * Model availability changes over time; every entry is overridable through the
 * plugin config (`models`), and `discoverFromApi` merges a live model listing
 * so new image models show up without a plugin release.
 *
 * @module dsh-siliconflow-image/catalog
 */

/** Route id the adapter registers. Kept distinct from the profile's `siliconflow` chat route. */
export const ROUTE = 'siliconflow-image'

/** Human-readable provider name shown in the model picker. */
export const PROVIDER_NAME = 'SiliconFlow 生图'

/**
 * Canonical ratio labels for every size this catalog offers.
 *
 * These are the *playground's* labels (also the ones in the API doc's
 * recommended-value table), not a reduced fraction: the provider's own names
 * are what the user sees, and several of them are not exact ratios — e.g.
 * Qwen-Image's `1472x1140` is labelled `4:3` although the true fraction is
 * 368:285. Computing gcd would print labels nobody recognises, which is why
 * this table is explicit and the gcd is only a fallback for unknown sizes.
 */
export const SIZE_RATIOS = Object.freeze({
  '1024x1024': '1:1',
  '832x1216': '2:3',
  '1216x832': '3:2',
  '896x1152': '3:4',
  '1152x896': '4:3',
  '768x1344': '9:16',
  '1344x768': '16:9',
  '1568x672': '21:9',
  '960x1280': '3:4',
  '768x1024': '3:4',
  '720x1440': '1:2',
  '720x1280': '9:16',
  '1328x1328': '1:1',
  '1664x928': '16:9',
  '928x1664': '9:16',
  '1472x1140': '4:3',
  '1140x1472': '3:4',
  '1584x1056': '3:2',
  '1056x1584': '2:3',
})

/**
 * `kind: 'generate'` accepts text → image. `kind: 'edit'` accepts text plus up
 * to three reference images. `size` is the recommended default; `null` means
 * the model rejects `image_size` (the Edit family).
 *
 * `sizes` / `maxSteps` / `defaultSteps` are the *request-gate* facts, measured
 * against the live API on 2026-11-12 (invalid requests are rejected before
 * billing, so each list was read out of the provider's own validation error):
 *  - most models cap `num_inference_steps` at 50 (the public doc says 100);
 *  - `OpenMOSS-Team/MOSS-Image` only accepts the eight listed ratio sizes;
 *  - the Edit family rejects `image_size` entirely.
 * Keep them beside `size` so the parameter panel and the tool share one truth.
 */
export const DEFAULT_MODELS = Object.freeze([
  {
    id: 'Kwai-Kolors/Kolors',
    name: 'Kolors (快手)',
    kind: 'generate',
    size: '1024x1024',
    sizes: ['1024x1024', '960x1280', '768x1024', '720x1440', '720x1280', '832x1216', '1216x832', '896x1152', '1152x896', '768x1344', '1344x768', '1568x672'],
    maxSteps: 50,
    defaultSteps: 20,
    description: '快手 Kolors 文生图，中文提示词友好、出图快；支持 guidance_scale（默认 7.5）。',
    defaults: { guidance_scale: 7.5 },
  },
  {
    id: 'Qwen/Qwen-Image',
    name: 'Qwen-Image',
    kind: 'generate',
    size: '1328x1328',
    sizes: ['1328x1328', '1664x928', '928x1664', '1472x1140', '1140x1472', '1584x1056', '1056x1584', '1024x1024'],
    maxSteps: 50,
    defaultSteps: 50,
    description: '通义 Qwen-Image 文生图，擅长含文字/排版的海报与信息图；官方配置 50 步、CFG 4.0。',
    defaults: { num_inference_steps: 50, cfg: 4 },
  },
  {
    id: 'Tongyi-MAI/Z-Image',
    name: 'Z-Image (通义 MAI)',
    kind: 'generate',
    size: '1024x1024',
    sizes: ['1024x1024', '832x1216', '1216x832', '896x1152', '1152x896', '768x1344', '1344x768', '1568x672'],
    maxSteps: 50,
    defaultSteps: 20,
    description: '通义 MAI 的 Z-Image 文生图模型。',
  },
  {
    id: 'Tongyi-MAI/Z-Image-Turbo',
    name: 'Z-Image-Turbo (通义 MAI)',
    kind: 'generate',
    size: '1024x1024',
    sizes: ['1024x1024', '832x1216', '1216x832', '896x1152', '1152x896', '768x1344', '1344x768', '1568x672'],
    maxSteps: 100,
    defaultSteps: 8,
    description: 'Z-Image 的加速版本，出图更快（接受 100 步以内，实测 60/101 步也放行）。',
  },
  {
    id: 'OpenMOSS-Team/MOSS-Image',
    name: 'MOSS-Image (OpenMOSS)',
    kind: 'generate',
    size: '1024x1024',
    sizes: ['1024x1024', '832x1216', '1216x832', '896x1152', '1152x896', '768x1344', '1344x768', '1568x672'],
    maxSteps: 50,
    defaultSteps: 40,
    description: 'OpenMOSS 团队的 MOSS 文生图模型；尺寸只接受列出的 8 种比例，步数上限 50（playground 默认 40 步）。',
  },
  {
    id: 'Qwen/Qwen-Image-Edit-2509',
    name: 'Qwen-Image-Edit-2509',
    kind: 'edit',
    size: null,
    sizes: [],
    maxSteps: 50,
    defaultSteps: 50,
    maxReferences: 3,
    description: 'Qwen 图像编辑（2509 版）：按提示词编辑 1–3 张参考图；选中后可在消息里附带参考图。',
    defaults: { num_inference_steps: 50, cfg: 4 },
  },
  {
    id: 'Qwen/Qwen-Image-Edit',
    name: 'Qwen-Image-Edit',
    kind: 'edit',
    size: null,
    sizes: [],
    maxSteps: 50,
    defaultSteps: 20,
    maxReferences: 1,
    description: 'Qwen 图像编辑模型：按提示词编辑一张参考图。',
  },
])

/** Ids that look like image-generation models when discovery is enabled. */
export const IMAGE_MODEL_PATTERN =
  /(?:image|kolors|z-image|flux|stable-diffusion|sd3|seedream|moss-image|ernie-i|gpt-image)/i

/**
 * Resolve one model id to its catalog entry, falling back to a synthetic
 * text-to-image entry so an id absent from the snapshot still routes.
 * @param {string} id - exact model id.
 * @param {readonly object[]} models - effective catalog (config overrides merged).
 * @returns {object} catalog entry.
 */
export function modelEntry(id, models) {
  const wanted = String(id ?? '').trim()
  for (const entry of models) if (entry.id === wanted) return entry
  // Models routinely drop the vendor prefix ("Qwen-Image" for
  // "Qwen/Qwen-Image") or the display name; resolve those aliases instead of
  // letting the provider answer HTTP 400 "model does not exist".
  const folded = wanted.toLowerCase()
  const alias = models.find((entry) => {
    const basename = entry.id.split('/').pop()?.toLowerCase()
    return basename === folded || String(entry.name ?? '').toLowerCase() === folded
  })
  if (alias !== undefined) return alias
  // Unknown id: assume the widely-accepted ratio set and the provider's
  // common step ceiling so the parameter gate never blocks a model the
  // catalog has not met yet.
  return {
    id: wanted,
    name: wanted,
    kind: 'generate',
    size: '1024x1024',
    sizes: ['1024x1024', '832x1216', '1216x832', '896x1152', '1152x896', '768x1344', '1344x768', '1568x672'],
    maxSteps: 50,
    description: '',
  }
}

/**
 * Merge user-supplied model overrides into the default catalog.
 * @param {unknown} overrides - array of `{id, name?, kind?, size?, description?, defaults?}`.
 * @returns {object[]} effective catalog (a fresh array).
 */
export function mergeModels(overrides) {
  if (!Array.isArray(overrides) || overrides.length === 0) return DEFAULT_MODELS.map((m) => ({ ...m }))
  return overrides
    .filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0)
    .map((item) => ({
      kind: item.kind === 'edit' ? 'edit' : 'generate',
      ...DEFAULT_MODELS.find((known) => known.id === item.id),
      ...item,
      id: item.id,
      name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
    }))
}

/**
 * Project one catalog entry into the adapter's `LlmModelInfo` shape.
 * @param {object} entry - catalog entry.
 * @returns {object} provider model metadata.
 */
export function modelInfo(entry) {
  const inputModalities = entry.kind === 'edit' ? ['text', 'image'] : ['text']
  return {
    id: entry.id,
    name: entry.name ?? entry.id,
    ...(entry.description ? { description: entry.description } : {}),
    inputModalities,
  }
}