import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../index.js'

/**
 * Host-level ctx double capturing what the plugin registers.
 * No real llm/tools/credentials — enough to exercise the gating branches.
 */
function fakeHost() {
  const adapters = []
  const tools = []
  const logs = []
  const ctx = {
    llm: { registerAdapter(routes) { adapters.push(...routes) } },
    tools: { register(def) { tools.push(def.name) } },
    sessions: {},
    get() { return undefined },
    logger: {
      info(m) { logs.push(m) },
      warn(m) { logs.push(m) },
    },
    // `inject` with no webServer service: the panel route is skipped harmlessly.
    inject() {},
  }
  return { ctx, adapters, tools, logs }
}

const baseConfig = {
  apiKeyRef: 'SILICONFLOW_API_KEY',
  baseURL: 'https://api.siliconflow.cn/v1',
  defaultModel: 'OpenMOSS-Team/MOSS-Image',
  outputDir: 'generated-images',
  watermark: false,
  timeoutMs: 600000,
  parameterPanel: false,
}

test('defaults: provider route + global tool both registered', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-sif-img-apply-'))
  const cfg = { ...baseConfig, paramsFile: path.join(workspace, '.p.json') }
  const { ctx, adapters, tools } = fakeHost()
  apply(ctx, cfg)
  assert.deepEqual(adapters, ['siliconflow-image'])
  assert.deepEqual(tools, ['generate_image'])
  await rm(workspace, { recursive: true, force: true })
})

test('providerRoute:false skips the route so no image model is selectable', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-sif-img-apply-'))
  const cfg = { ...baseConfig, paramsFile: path.join(workspace, '.p.json'), providerRoute: false }
  const { ctx, adapters, tools, logs } = fakeHost()
  apply(ctx, cfg)
  assert.deepEqual(adapters, [])
  assert.ok(tools.includes('generate_image'))
  assert.ok(logs.some((m) => m.includes('provider route skipped')))
  await rm(workspace, { recursive: true, force: true })
})

test('toolGlobal:false skips the global tool (preset-image mounts it instead)', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-sif-img-apply-'))
  const cfg = { ...baseConfig, paramsFile: path.join(workspace, '.p.json'), toolGlobal: false }
  const { ctx, adapters, tools, logs } = fakeHost()
  apply(ctx, cfg)
  assert.deepEqual(adapters, ['siliconflow-image'])
  assert.deepEqual(tools, [])
  assert.ok(logs.some((m) => m.includes('generate_image" skipped')))
  await rm(workspace, { recursive: true, force: true })
})

test('both flags false: image plugin is tool-only via preset, nothing global', async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), 'dsh-sif-img-apply-'))
  const cfg = { ...baseConfig, paramsFile: path.join(workspace, '.p.json'), providerRoute: false, toolGlobal: false }
  const { ctx, adapters, tools } = fakeHost()
  apply(ctx, cfg)
  assert.deepEqual(adapters, [])
  assert.deepEqual(tools, [])
  await rm(workspace, { recursive: true, force: true })
})

test('invalid providerRoute is rejected', () => {
  const cfg = { ...baseConfig, providerRoute: 'yes' }
  assert.throws(() => apply(fakeHost().ctx, cfg), /providerRoute must be a boolean/)
})
