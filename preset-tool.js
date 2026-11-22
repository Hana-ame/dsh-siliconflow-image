/**
 * Preset-scope plugin: register `generate_image` only for sessions that
 * selected the image preset.
 *
 * Mounted by `preset-image` (declared in this bundle's `cordis.patch.yml`).
 * The tool definition is reused verbatim from `./src/tool.js` — same
 * `createGenerateImageTool` the bundle-level mount calls — so behavior,
 * parameters, and output are identical to the global variant. The only
 * difference is the registry layer: preset-scope tools are visible only to
 * sessions on that preset, not to every agent on the host.
 *
 * `restrict` can only deny *inherited* global tools, never a scope's own
 * registrations. To keep this preset image-only we deny the known inherited
 * globals (see `DENY_GLOBAL`), matching the pattern in `dsh-peer-message/tool.js`.
 *
 * The `/api/siliconflow-image/params` route and the assistant-image projection
 * stay registered by the bundle-level `index.js` — they are process-global or
 * UI seams, not per-preset.
 *
 * @module dsh-siliconflow-image/preset-tool
 */

import { createGenerateImageTool } from './src/tool.js'

export const name = 'siliconflow-image-preset-tool'

export const inject = ['tools']

/**
 * Known inherited Host-global tools this preset denies, so the image agent's
 * tool list stays focused on `generate_image`. Matches the documented
 * inherited set (see `dsh-peer-message/tool.js` DENY_GLOBAL).
 * @type {string[]}
 */
export const DENY_GLOBAL = [
  // Browser automation (dsh-browser, Host plane).
  'browser_open', 'browser_navigate', 'browser_click', 'browser_type',
  'browser_select', 'browser_screenshot', 'browser_eval', 'browser_get_html',
  'browser_get_text', 'browser_wait', 'browser_close', 'browser_install',
  // Main-session review injection (Host plane).
  'inject_context_read', 'inject_deliver', 'inject_user_inputs',
  // General-purpose web tools; the image preset is image-only.
  'web_fetch', 'web_search',
]

/**
 * @param {object} ctx - preset scope context (inject: ['tools']).
 * @param {object} [config] - loader row config, same shape as the bundle row.
 */
export function apply(ctx, config) {
  const effective = config && typeof config === 'object' ? config : {}
  ctx.tools.register(createGenerateImageTool({ ctx, config: effective, paramStore: undefined }))

  // Keep the tool list focused: deny the inherited globals, keep this scope's
  // own `generate_image`. Errors on unknown names are swallowed so a future DSH
  // that renames an inherited tool cannot break preset activation.
  try {
    ctx.tools.restrict({ deny: DENY_GLOBAL })
  } catch {
    /* best-effort: restrict is a soft filter, never a hard dependency */
  }
}
