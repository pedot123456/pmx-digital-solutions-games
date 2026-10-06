/**
 * Phone audit: plays every screen of the game, Multiplayer Battle, the TV display and Admin at phone sizes
 * (Edge / Chrome with mobile emulation) on a throw-away database. Flags anything wider than the screen,
 * content that can't be scrolled to, small tap targets and tiny text, and saves a screenshot of each screen.
 * Usage: npm run build && npm run e2e:mobile      Screenshots: tests/e2e/output/mobile/
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(ROOT, 'tests/e2e/output/mobile')
const PORT = 8098
const BASE = `http://localhost:${PORT}`
const PIN = '582914'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'

type Size = { name: string; w: number; h: number; ua: string }
const PHONES: Size[] = [
  { name: '360x740-android', w: 360, h: 740, ua: ANDROID_UA },
  { name: '390x844-iphone', w: 390, h: 844, ua: IPHONE_UA },
  { name: '430x932-large', w: 430, h: 932, ua: IPHONE_UA },
]
const LANDSCAPE: Size = { name: '844x390-landscape', w: 844, h: 390, ua: IPHONE_UA }

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  (${detail})` : ''}`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const sel = (id: string) => `[data-testid="${id}"]`

function findBrowser(): string {
  const candidates = [
    process.env.BROWSER_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean) as string[]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error('No Edge/Chrome found – set BROWSER_PATH')
  return found
}

async function startServer(dataDir: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), 'server/index.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, '..', 'backups'), LOG_LEVEL: 'error', PUBLIC_BASE_URL: '', DATABASE_URL: '', ADMIN_DEFAULT_PIN: '1234' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`))
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${BASE}/api/health`)).ok) return child
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('server did not start')
}

let token = ''
async function api<T>(p: string, opts: { method?: string; json?: unknown } = {}): Promise<T> {
  const res = await fetch(BASE + p, {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  })
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`)
  return body as T
}
let solutions: { id: string; name: string; clue: string }[] = []

async function waitFor(page: Page, id: string, timeout = 15000) {
  return page.waitForSelector(sel(id), { visible: true, timeout })
}
/** Taps like a thumb: scrolls the control to the middle first. */
async function tap(page: Page, id: string) {
  const el = await waitFor(page, id)
  await el!.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await el!.click()
}
async function typeInto(page: Page, id: string, value: string) {
  await page.waitForSelector(sel(id), { visible: true })
  await page.click(sel(id), { count: 3 })
  await page.keyboard.press('Backspace')
  await page.type(sel(id), value)
}

async function phone(browser: Browser, size: Size, hash: string): Promise<Page> {
  const page = await (await browser.createBrowserContext()).newPage()
  await page.setUserAgent(size.ua)
  await page.setViewport({ width: size.w, height: size.h, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => check(`no page errors (${size.name})`, false, String(e)))
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' })
  return page
}

/**
 * The page fits the phone: nothing wider than the screen (outside scrollable strips), everything reachable
 * by scrolling, tap targets ≥ 44 px, text ≥ 11 px. Saves a full-page screenshot.
 */
async function audit(page: Page, size: Size, label: string, opts: { minTarget?: number } = {}) {
  await sleep(500)
  const minTarget = opts.minTarget ?? 44
  // A string, so tsx adds no __name() helpers to the page code.
  const r = (await page.evaluate(`(() => {
    const vw = innerWidth, vh = innerHeight, d = document.documentElement
    const clipped = (el) => {
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const s = getComputedStyle(p)
        if (s.overflowX === 'auto' || s.overflowX === 'scroll' || s.overflowX === 'hidden' || s.overflowX === 'clip') return true
      }
      return false
    }
    const name = (el) => el.getAttribute('data-testid') || (el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.split(' ').slice(0, 3).join('.') : '')) + ' "' + (el.textContent || '').trim().slice(0, 24) + '"'
    const wide = []
    const tiny = []
    for (const el of document.querySelectorAll('body *')) {
      const b = el.getBoundingClientRect()
      const s = getComputedStyle(el)
      if (!b.width || !b.height || s.visibility === 'hidden' || s.display === 'none') continue
      if ((b.right > vw + 1 || b.left < -1) && s.position !== 'fixed' && !clipped(el)) wide.push(name(el) + ' [' + Math.round(b.left) + '..' + Math.round(b.right) + ']')
      const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
      if (ownText && parseFloat(s.fontSize) < 11 && !el.closest('[aria-hidden="true"]')) tiny.push(name(el) + ' ' + s.fontSize)
    }
    const small = [...document.querySelectorAll('button, a[href], [role="button"], [role="radio"], [role="checkbox"], [role="tab"], input:not([type="checkbox"]):not([type="radio"]), select')]
      .filter((e) => { const b = e.getBoundingClientRect(); const s = getComputedStyle(e); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && !e.closest('[aria-hidden="true"]') && !e.closest('[data-testid="ticker"]') && (b.height < ${minTarget} - 0.5 || b.width < ${minTarget} - 0.5) })
      .map((e) => name(e) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height))
    const bodyY = getComputedStyle(document.body).overflowY
    const htmlY = getComputedStyle(d).overflowY
    const tall = d.scrollHeight > vh + 1
    return { vw, vh, sw: d.scrollWidth, sh: d.scrollHeight, wide, tiny, small, locked: tall && (bodyY === 'hidden' || htmlY === 'hidden') }
  })()`)) as { vw: number; vh: number; sw: number; sh: number; wide: string[]; tiny: string[]; small: string[]; locked: boolean }
  const tag = `${size.name} · ${label}`
  check(`${tag}: no sideways scroll`, r.sw <= r.vw + 1, `${r.sw} > ${r.vw}`)
  check(`${tag}: nothing wider than the screen`, r.wide.length === 0, r.wide.slice(0, 4).join(' | '))
  check(`${tag}: everything can be scrolled to`, !r.locked, `page ${r.sh}px tall in ${r.vh}px but scrolling is off`)
  check(`${tag}: tap targets ≥ ${minTarget} px`, r.small.length === 0, r.small.slice(0, 5).join(' | '))
  check(`${tag}: text ≥ 11 px`, r.tiny.length === 0, r.tiny.slice(0, 5).join(' | '))
  // A full-page capture stretches the viewport, which would switch a sideways phone back to the big-screen layout.
  await page.screenshot({ path: path.join(OUT, `${size.name}-${label}.png`), fullPage: size.h > 520 })
}

/** The bottom of an element is on screen without scrolling. */
async function inView(page: Page, selector: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return false
    const b = el.getBoundingClientRect()
    return b.top >= 0 && b.bottom <= innerHeight + 1
  }, selector)
}

async function register(page: Page, prefix: string, name: string, project: string) {
  await typeInto(page, `${prefix}full-name`, name)
  await tap(page, `${prefix}from-project`)
  await sleep(450)
  await typeInto(page, `${prefix}project-name`, project)
  const consent = await page.$eval(sel(`${prefix}consent`), (e) => (e as HTMLInputElement).checked)
  if (!consent) await page.$eval(sel(`${prefix}consent`), (e) => (e as HTMLInputElement).click())
}

/** Builds the current solution by tapping its tiles. */
async function solveCurrent(page: Page, scope: string): Promise<boolean> {
  const clue = await page.$eval(`${sel(scope)} ${sel('clue')}`, (e) => (e as HTMLElement).innerText).catch(() => '')
  if (!clue || /Get ready|Round complete/.test(clue)) return false
  const s = solutions.find((x) => x.clue.trim() === clue.trim())
  if (!s) return false
  for (const t of s.name.split(' ')) {
    const handle = await page.evaluateHandle(
      (scopeSel, tok) => [...document.querySelectorAll(`${scopeSel} [data-testid="tiles"] button`)].find((b) => (b as HTMLButtonElement).dataset.text === tok && !(b as HTMLButtonElement).disabled) ?? null,
      sel(scope),
      t,
    )
    const el = handle.asElement()
    if (!el) return false
    await (el as unknown as { click: () => Promise<void> }).click()
    await sleep(60)
  }
  return true
}

async function waitGo(page: Page) {
  await page.waitForSelector(sel('countdown'), { timeout: 15000 }).catch(() => {})
  await page.waitForFunction(() => !document.querySelector('[data-testid="countdown"]'), { timeout: 15000 })
  await sleep(200)
}

async function answerFeedback(page: Page) {
  await waitFor(page, 'feedback-form', 20000)
  await tap(page, 'q1-yes')
  await tap(page, 'q2-yes')
  await sleep(400)
  await tap(page, `chip-${solutions[0].id}`)
  await tap(page, 'q3-star-4')
  await tap(page, 'feedback-submit')
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function soloOnPhone(browser: Browser, size: Size, n: number) {
  console.log(`\n▶ Solo Rush on a phone (${size.name})`)
  const page = await phone(browser, size, '#/')
  await page.waitForFunction(() => !document.querySelector('[data-testid="splash"]'), { timeout: 8000 })
  await waitFor(page, 'home')
  await audit(page, size, '01-home')
  check(`${size.name}: Head-to-Head is hidden on phones`, (await page.$(sel('mode-h2h'))) === null || !(await page.$eval(sel('mode-h2h'), (e) => (e as HTMLElement).offsetParent !== null)))
  await tap(page, 'tap-to-begin')
  await waitFor(page, 'solo-register')
  await audit(page, size, '02-register')
  await register(page, '', `Phone Player ${'ABC'[n]}`, 'Kasawari CCS')
  await tap(page, 'start')
  await waitFor(page, 'howto')
  await audit(page, size, '03-howto')
  await tap(page, 'ready')
  await waitGo(page)
  await audit(page, size, '04-game')
  check(`${size.name}: timer on screen while playing`, await inView(page, sel('timer')))
  check(`${size.name}: clue on screen while playing`, await inView(page, sel('clue')))
  check(`${size.name}: every tile on screen without scrolling`, await page.evaluate(() => [...document.querySelectorAll('[data-testid="tiles"] button')].every((b) => b.getBoundingClientRect().bottom <= innerHeight + 1)))
  let solved = 0
  for (let i = 0; i < 6; i++) if (await solveCurrent(page, 'solo-race')) solved++
  check(`${size.name}: all 6 solutions playable on the phone`, solved === 6, String(solved))
  await waitFor(page, 'reveal', 10000)
  await sleep(1800)
  await audit(page, size, '05-reveal')
  await waitFor(page, 'feedback-form', 20000)
  await audit(page, size, '06-feedback')
  await answerFeedback(page)
  await waitFor(page, 'results', 15000)
  await page.waitForFunction(() => document.querySelector('[data-testid="title"]'), { timeout: 10000 })
  await audit(page, size, '07-results')
  await tap(page, 'continue')
  await waitFor(page, 'leaderboard')
  await audit(page, size, '08-leaderboard-today')
  await tap(page, 'tab-wins')
  await audit(page, size, '09-leaderboard-wins')
  await tap(page, 'done')
  await waitFor(page, 'home')
  await audit(page, size, '10-home-with-scores')
  await page.close()
}

async function battleOnPhones(browser: Browser, size: Size) {
  console.log(`\n▶ Multiplayer Battle hosted and played on phones (${size.name})`)
  const host = await phone(browser, size, '#/')
  await host.waitForFunction(() => !document.querySelector('[data-testid="splash"]'), { timeout: 8000 })
  await tap(host, 'mode-battle')
  await waitFor(host, 'lobby')
  const code = (await host.$eval(sel('room-code'), (e) => (e as HTMLElement).innerText)).trim()
  await audit(host, size, '11-battle-lobby-host')
  const a = await phone(browser, size, '#/join')
  await waitFor(a, 'code-step')
  await audit(a, size, '12-join-code')
  await typeInto(a, 'room-code-input', code)
  await tap(a, 'code-next')
  await waitFor(a, 'phone-register')
  await audit(a, size, '13-join-register')
  await register(a, '', 'Battle Alya', 'Jerun')
  await tap(a, 'start')
  await waitFor(a, 'phone-lobby')
  const b = await phone(browser, size, `#/join/${code}`)
  await waitFor(b, 'phone-register')
  await register(b, '', 'Battle Badrul', 'Jerun')
  await tap(b, 'start')
  await waitFor(b, 'phone-lobby')
  await sleep(500)
  await audit(a, size, '14-join-lobby')
  await audit(host, size, '15-battle-lobby-full')
  await tap(host, 'start-battle')
  await waitFor(a, 'howto', 8000)
  await audit(a, size, '16-join-howto')
  await waitFor(a, 'phone-game', 15000)
  await waitGo(a)
  await audit(a, size, '17-join-game')
  await audit(host, size, '18-battle-race-host')
  for (let i = 0; i < 6; i++) await solveCurrent(a, 'phone-game')
  for (let i = 0; i < 2; i++) await solveCurrent(b, 'phone-game')
  await waitFor(host, 'battle-results', 40000)
  await audit(host, size, '19-battle-results-host')
  await waitFor(a, 'feedback-form', 25000)
  await audit(a, size, '20-join-feedback')
  await answerFeedback(a)
  await waitFor(a, 'phone-results', 15000)
  await audit(a, size, '21-join-results')
  for (const p of [host, a, b]) await p.close()
}

async function adminOnPhone(browser: Browser, size: Size) {
  console.log(`\n▶ Admin and TV display on a phone (${size.name})`)
  const page = await phone(browser, size, '#/admin')
  await typeInto(page, 'admin-pin', PIN)
  await tap(page, 'admin-login-submit')
  await waitFor(page, 'dashboard')
  // Admin is a dense staff tool: WCAG's 24 px minimum target size applies there (buttons get 44 px on touch screens).
  const tabs = ['dashboard', 'feedback', 'live', 'results', 'boards', 'solutions', 'settings', 'projects', 'data', 'audit', 'pin']
  for (const t of tabs) {
    await page.select('select[aria-label="Admin section"]', t)
    await sleep(900)
    await audit(page, size, `30-admin-${t}`, { minTarget: 24 })
  }
  await page.goto(`${BASE}/#/display`, { waitUntil: 'networkidle2' })
  await waitFor(page, 'display')
  await audit(page, size, '40-tv-display', { minTarget: 24 })
  await page.close()
}

async function landscape(browser: Browser) {
  console.log(`\n▶ A phone turned sideways (${LANDSCAPE.name})`)
  const page = await phone(browser, LANDSCAPE, '#/')
  await page.waitForFunction(() => !document.querySelector('[data-testid="splash"]'), { timeout: 8000 })
  await audit(page, LANDSCAPE, '01-home')
  await tap(page, 'tap-to-begin')
  await waitFor(page, 'solo-register')
  await audit(page, LANDSCAPE, '02-register')
  await register(page, '', 'Sideways Sam', 'Jerun')
  await tap(page, 'start')
  await tap(page, 'ready')
  await waitGo(page)
  await audit(page, LANDSCAPE, '04-game')
  for (let i = 0; i < 6; i++) await solveCurrent(page, 'solo-race')
  await waitFor(page, 'feedback-form', 25000)
  await audit(page, LANDSCAPE, '06-feedback')
  await answerFeedback(page)
  await waitFor(page, 'results', 15000)
  await audit(page, LANDSCAPE, '07-results')
  await page.close()
}

async function main() {
  if (!existsSync(path.join(ROOT, 'dist/client/index.html'))) throw new Error('Run "npm run build" first.')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const tmp = mkdtempSync(path.join(tmpdir(), 'wordrush-mobile-'))
  const server = await startServer(path.join(tmp, 'data'))
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'] })
  const started = Date.now()
  try {
    const first = await api<{ token: string }>('/api/admin/login', { json: { pin: '1234' } })
    token = first.token
    await api('/api/admin/pin', { json: { current: '1234', next: PIN } })
    token = (await api<{ token: string }>('/api/admin/login', { json: { pin: PIN } })).token
    solutions = await api('/api/admin/solutions')
    await api('/api/admin/settings', { method: 'PUT', json: { timer_seconds: 20, howto_seconds: 3, public_base_url: BASE } })
    for (const [i, size] of PHONES.entries()) await soloOnPhone(browser, size, i)
    await battleOnPhones(browser, PHONES[0])
    await adminOnPhone(browser, PHONES[0])
    await landscape(browser)
  } catch (err) {
    check('scenario completed without errors', false, (err as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(err))
    for (const [i, p] of (await browser.pages()).entries()) await p.screenshot({ path: path.join(OUT, `FAIL-${i}.png`) }).catch(() => {})
  } finally {
    await browser.close()
    server.kill()
    await sleep(500)
    rmSync(tmp, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} phone checks passed in ${Math.round((Date.now() - started) / 1000)} s. Screenshots: ${OUT}`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
    process.exitCode = 1
  }
}

void main()
