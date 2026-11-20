import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_MODELS, modelEntry } from '../src/catalog.js'
import {
  assertSize,
  defaultStepsOf,
  maxStepsOf,
  MAX_SEED,
  normalizeParams,
  ParamStore,
  ratioLabel,
  sizesOf,
  usableParams,
} from '../src/params.js'

const moss = modelEntry('OpenMOSS-Team/MOSS-Image', DEFAULT_MODELS)
const edit = modelEntry('Qwen/Qwen-Image-Edit', DEFAULT_MODELS)
const turbo = modelEntry('Tongyi-MAI/Z-Image-Turbo', DEFAULT_MODELS)

test('ratioLabel uses the provider’s own labels, not a reduced fraction', () => {
  // The playground calls 1216x832 "3:2" although the exact fraction is 19:13;
  // printing the gcd would show a label no user recognises.
  assert.equal(ratioLabel('1024x1024'), '1:1')
  assert.equal(ratioLabel('1216x832'), '3:2')
  assert.equal(ratioLabel('832x1216'), '2:3')
  assert.equal(ratioLabel('768x1344'), '9:16')
  assert.equal(ratioLabel('1568x672'), '21:9')
  // Qwen-Image's 4:3 is likewise a provider label, not the true fraction.
  assert.equal(ratioLabel('1472x1140'), '4:3')
  // Unknown sizes still get a sane fallback.
  assert.equal(ratioLabel('1000x1000'), '1:1')
  assert.equal(ratioLabel('nope'), '')
})

test('the catalog declares the measured per-model size set and step cap', () => {
  assert.equal(sizesOf(moss).length, 8)
  assert.ok(sizesOf(moss).includes('1568x672'))
  assert.ok(!sizesOf(moss).includes('1328x1328'), 'MOSS rejects Qwen-Image’s 1328 square')
  assert.equal(maxStepsOf(moss), 50)
  assert.equal(defaultStepsOf(moss), 40)
  assert.equal(maxStepsOf(turbo), 100, 'Z-Image-Turbo is the one model that passes 50 steps')
  assert.deepEqual(sizesOf(edit), [], 'the Edit family rejects image_size')
})

test('assertSize accepts only the model’s own sizes', () => {
  assert.equal(assertSize('moss', '1024x1024', moss), '1024x1024')
  assert.throws(() => assertSize('moss', '1328x1328', moss), /accepts image_size/)
  assert.throws(() => assertSize('edit', '1024x1024', edit), /does not accept image_size/)
})

test('normalizeParams rejects unknown keys instead of dropping them', () => {
  assert.deepEqual(normalizeParams({}, moss), {})
  assert.deepEqual(normalizeParams({ seed: 0 }, moss), { seed: 0 })
  assert.throws(() => normalizeParams({ cfg: 4 }, moss), /unknown image parameter "cfg"/)
  assert.throws(() => normalizeParams({ num_inference_steps: 51 }, moss), /integer in \[1, 50\]/)
  assert.throws(() => normalizeParams({ seed: MAX_SEED + 1 }, moss), /integer in \[0, 9999999999\]/)
  assert.throws(() => normalizeParams({ image_size: '1024x1024' }, edit), /does not accept image_size/)
  // Empty values are "unset", not errors.
  assert.deepEqual(normalizeParams({ negative_prompt: '   ', seed: null }, moss), {})
})

test('usableParams drops stored values the current model cannot accept', () => {
  const stored = { image_size: '1328x1328', num_inference_steps: 90, seed: 42, negative_prompt: 'text' }
  assert.deepEqual(usableParams(stored, moss), { seed: 42, negative_prompt: 'text' })
  // Qwen-Image accepts the square, but 90 steps still exceeds its cap, so the
  // step value is dropped (the adapter then falls back to the catalog default).
  assert.deepEqual(usableParams(stored, modelEntry('Qwen/Qwen-Image', DEFAULT_MODELS)), {
    image_size: '1328x1328',
    seed: 42,
    negative_prompt: 'text',
  })
  assert.deepEqual(usableParams({ num_inference_steps: 30 }, modelEntry('Qwen/Qwen-Image', DEFAULT_MODELS)), {
    num_inference_steps: 30,
  })
  assert.deepEqual(usableParams(undefined, moss), {})
})

test('ParamStore persists per session and reloads from disk', async () => {
  const directory = await os.tmpdir()
  const filePath = path.join(directory, `sfi-params-${process.pid}-${Date.now()}.json`)
  try {
    const store = new ParamStore({ filePath })
    await store.load()
    assert.deepEqual(store.get('s1'), {})
    await store.set('s1', { seed: 7, image_size: '1024x1024' })
    await store.set('s2', { negative_prompt: 'watermark' })

    const reloaded = new ParamStore({ filePath })
    await reloaded.load()
    assert.deepEqual(reloaded.get('s1'), { seed: 7, image_size: '1024x1024' })
    assert.deepEqual(reloaded.get('s2'), { negative_prompt: 'watermark' })

    // An empty bag deletes the entry rather than storing `{}`.
    await reloaded.set('s1', {})
    const afterClear = new ParamStore({ filePath })
    await afterClear.load()
    assert.deepEqual(afterClear.get('s1'), {})
  } finally {
    await rm(filePath, { force: true })
  }
})

test('ParamStore without a file stays memory-only', async () => {
  const store = new ParamStore({})
  await store.load()
  await store.set('s1', { seed: 1 })
  assert.deepEqual(store.get('s1'), { seed: 1 })
})
