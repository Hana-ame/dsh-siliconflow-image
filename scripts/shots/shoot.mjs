/**
 * Deterministic UI screenshot for the parameter panel.
 *
 * The shared dsh-browser tool is a single browser instance also used by other
 * sessions, so it can be navigated away mid-run. This script owns a private
 * Chromium, logs in with the instance token, selects the image provider, opens
 * the panel and captures it — no hand-driven clicking.
 *
 * Usage: node scripts/shots/shoot.mjs <token> <outDir>
 */
import { createRequire } from 'node:module'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

const require = createRequire('/home/lumin/.dsh/plugins/dsh-browser/')
const { chromium } = require('playwright-core')

const token = process.argv[2]
const outDir = process.argv[3] ?? '/tmp/sfi-shots'
if (!token) throw new Error('usage: shoot.mjs <token> <outDir>')
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const log = (...args) => console.log('[shot]', ...args)

try {
  // 1. Log in through the token, then land on a clean app page.
  await page.goto(`http://127.0.0.1:3080/?token=${token}`, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('.gg-fab, [data-composer-input]', { timeout: 30000 })
  log('app loaded')

  // 2. The panel is provider-gated: select the image route through the model picker.
  const alreadyImage = await page.$('.sfi-wrap')
  if (alreadyImage === null) {
    await page.click('.gg-fab')
    await page.waitForSelector('.gg-tab', { timeout: 10000 })
    await page.click('.gg-tab:has-text("SiliconFlow 生图")')
    await page.waitForSelector('.gg-chip', { timeout: 10000 })
    await page.click('.gg-chip[aria-label="选择 MOSS-Image (OpenMOSS)"]')
    await page.waitForSelector('.sfi-wrap', { timeout: 15000 })
  }
  log('image provider selected:', await page.textContent('.gg-name'))

  // 3. Open the panel and capture the four fields.
  const expanded = await page.getAttribute('.sfi-trigger', 'aria-expanded')
  if (expanded !== 'true') await page.click('.sfi-trigger')
  await page.waitForSelector('.sfi-panel', { timeout: 10000 })
  await page.waitForTimeout(400)

  const state = await page.evaluate(() => {
    const panel = document.querySelector('.sfi-panel')
    return {
      seat: document.querySelector('.gg-name')?.innerText ?? null,
      titles: [...panel.querySelectorAll('.sfi-rowTitle')].map((n) => n.innerText),
      sizes: [...panel.querySelectorAll('.sfi-size')].map((n) => `${n.querySelector('.sfi-ratio').innerText} ${n.querySelector('.sfi-px').innerText}`),
      stepsRange: { max: panel.querySelector('.sfi-range')?.max, value: panel.querySelector('.sfi-range')?.value },
      stepsBox: panel.querySelectorAll('.sfi-num')[0]?.value,
      seedPlaceholder: panel.querySelectorAll('.sfi-num')[1]?.placeholder,
      hasNegative: panel.querySelector('.sfi-textarea') !== null,
      buttons: [...panel.querySelectorAll('.sfi-btn')].map((n) => n.innerText),
    }
  })
  log('panel state:', JSON.stringify(state))

  await page.screenshot({ path: path.join(outDir, '01-panel-collapsed-context.png') })
  // The panel element alone, at full resolution, so the alignment is inspectable.
  await page.locator('.sfi-wrap').screenshot({ path: path.join(outDir, '02-panel.png') })

  // 4. Pick a size and confirm the summary + stored value follow.
  await page.click('.sfi-size:has-text("3:2")')
  await page.waitForTimeout(600)
  const afterPick = await page.evaluate(() => ({
    summary: document.querySelector('.sfi-sum')?.innerText ?? null,
    pressed: [...document.querySelectorAll('.sfi-size')].map((n) => n.getAttribute('aria-pressed')),
  }))
  log('after size pick:', JSON.stringify(afterPick))
  await page.locator('.sfi-wrap').screenshot({ path: path.join(outDir, '03-panel-size-picked.png') })

  // 5. Compare against the reference playground layout by printing both grids.
  console.log('RESULT ' + JSON.stringify({ state, afterPick }))
} finally {
  await browser.close()
}
