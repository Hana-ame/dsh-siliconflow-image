import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_MODELS, IMAGE_MODEL_PATTERN, mergeModels, modelEntry, modelInfo, ROUTE } from '../src/catalog.js'

test('route id is distinct from the chat provider and stable', () => {
  assert.equal(ROUTE, 'siliconflow-image')
})

test('default catalog exposes text-to-image and edit models', () => {
  assert.ok(DEFAULT_MODELS.length >= 5)
  const kolors = DEFAULT_MODELS.find((entry) => entry.id === 'Kwai-Kolors/Kolors')
  assert.deepEqual(modelInfo(kolors).inputModalities, ['text'])
  const edit = DEFAULT_MODELS.find((entry) => entry.id === 'Qwen/Qwen-Image-Edit-2509')
  assert.deepEqual(modelInfo(edit).inputModalities, ['text', 'image'])
  assert.equal(edit.size, null)
})

test('every default model matches the discovery pattern', () => {
  for (const entry of DEFAULT_MODELS) assert.match(entry.id, IMAGE_MODEL_PATTERN)
})

test('modelEntry falls back to a synthetic generate entry', () => {
  const entry = modelEntry('vendor/Unknown-Image', [])
  assert.equal(entry.id, 'vendor/Unknown-Image')
  assert.equal(entry.kind, 'generate')
  assert.equal(entry.size, '1024x1024')
})

test('mergeModels applies overrides and drops malformed items', () => {
  const merged = mergeModels([
    { id: 'Kwai-Kolors/Kolors', name: 'Kolors 自定义', size: '768x1024' },
    { id: 'vendor/New-Image' },
    { name: 'no id' },
  ])
  assert.equal(merged.length, 2)
  assert.equal(merged[0].name, 'Kolors 自定义')
  assert.equal(merged[0].size, '768x1024')
  assert.equal(merged[0].kind, 'generate', 'defaults from the snapshot survive an override')
  assert.equal(merged[1].name, 'vendor/New-Image')
})

test('mergeModels with no overrides returns a mutable copy', () => {
  const merged = mergeModels(undefined)
  assert.equal(merged.length, DEFAULT_MODELS.length)
  merged[0].name = 'mutated'
  assert.notEqual(DEFAULT_MODELS[0].name, 'mutated')
})
test('modelEntry resolves vendor-prefix and display-name aliases', () => {
  const models = mergeModels(undefined)
  assert.equal(modelEntry('Qwen-Image', models).id, 'Qwen/Qwen-Image')
  assert.equal(modelEntry('kolors (快手)', models).id, 'Kwai-Kolors/Kolors')
  assert.equal(modelEntry('qwEn-image-edit-2509', models).id, 'Qwen/Qwen-Image-Edit-2509')
})

test('every model declares a request-gate size set and step cap', () => {
  for (const entry of DEFAULT_MODELS) {
    assert.ok(Array.isArray(entry.sizes), `${entry.id} declares sizes`)
    assert.ok(Number.isInteger(entry.maxSteps) && entry.maxSteps >= 1, `${entry.id} declares maxSteps`)
    if (entry.kind === 'edit') {
      assert.deepEqual(entry.sizes, [], `${entry.id} rejects image_size`)
      continue
    }
    assert.ok(entry.sizes.length > 0, `${entry.id} offers at least one size`)
    assert.ok(entry.sizes.includes(entry.size), `${entry.id}’s default size is in its own set`)
  }
})

test('sizes stay within the provider’s measured pixel budget', () => {
  // Measured bounds: each side > 256 and <= 2047, and width*height <= 2073600
  // on Qwen-Image (the tightest model).
  for (const entry of DEFAULT_MODELS) {
    for (const size of entry.sizes ?? []) {
      const [width, height] = size.split('x').map(Number)
      assert.ok(width > 256 && height > 256, `${entry.id} ${size} sides exceed 256`)
      assert.ok(width <= 2047 && height <= 2047, `${entry.id} ${size} sides stay under 2048`)
      assert.ok(width * height <= 2073600, `${entry.id} ${size} fits the pixel budget`)
    }
  }
})
