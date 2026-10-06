/**
 * End-to-end acceptance run in Edge/Chrome against a real server on a throw-away database.
 * Usage: npm run build && npm run e2e
 * Screenshots go to tests/e2e/output/.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'

const ROOT = path.resolve(import.meta.dirname, '../..')
const OUT = path.join(ROOT, 'tests/e2e/output')
const PORT = 8097
const BASE = `http://localhost:${PORT}`
const NEW_PIN = '582914'

const results: { name: string; ok: boolean; detail: string }[] = []
function check(name: string, ok: boolean, detail = '') {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
const section = (s: string) => console.log(`\n▶ ${s}`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, BACKUP_DIR: path.join(dataDir, '..', 'backups'), LOG_LEVEL: 'error', PUBLIC_BASE_URL: '', ADMIN_DEFAULT_PIN: '1234' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`))
  for (let i = 0; i < 240; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return child
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('server did not start')
}

// ── API helpers (used to read the answers and change settings) ──────────────

let adminToken = ''
async function api<T>(p: string, opts: { method?: string; json?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(BASE + p, {
    method: opts.method ?? (opts.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  })
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text()
  if (!res.ok) throw new Error(`${p} → ${res.status} ${JSON.stringify(body)}`)
  return body as T
}
const setSettings = (patch: Record<string, unknown>) => api('/api/admin/settings', { method: 'PUT', json: patch, token: adminToken })
type Sol = { id: string; name: string; clue: string }
let solutions: Sol[] = []
const refreshSolutions = async () => {
  solutions = await api<Sol[]>('/api/admin/solutions', { token: adminToken })
}

// ── Page helpers ────────────────────────────────────────────────────────────

const sel = (id: string) => `[data-testid="${id}"]`
async function waitFor(page: Page, id: string, timeout = 15000) {
  return page.waitForSelector(sel(id), { visible: true, timeout })
}
async function click(page: Page, id: string) {
  const el = await waitFor(page, id)
  await el!.click()
}
async function shot(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) })
}
async function has(page: Page, id: string, timeout = 4000) {
  try {
    await waitFor(page, id, timeout)
    return true
  } catch {
    return false
  }
}
async function text(page: Page, selector: string): Promise<string> {
  return page.$eval(selector, (e) => (e as HTMLElement).innerText).catch(() => '')
}
async function typeInto(page: Page, selector: string, value: string) {
  await page.waitForSelector(selector, { visible: true })
  await page.click(selector, { count: 3 })
  await page.keyboard.press('Backspace')
  await page.type(selector, value)
}

/** Answer tokens for the clue currently shown in `scope` (word tiles, or letters in Hard Mode). */
function tokensFor(clue: string, hard: boolean): string[] {
  const s = solutions.find((x) => x.clue.trim() === clue.trim())
  if (!s) throw new Error(`no solution for clue "${clue}"`)
  return s.name.split(' ').flatMap((w) => (hard && w.length >= 2 && w.length <= 4 ? w.split('') : [w]))
}

/** Taps the right tiles for the current puzzle inside `scope` (a board test id). Returns false if no puzzle. */
async function solveCurrent(page: Page, scope: string, hard = false, wait = 60): Promise<boolean> {
  const clue = await text(page, `${sel(scope)} ${sel('clue')}`)
  if (!clue || /Get ready|Round complete/.test(clue)) return false
  const tokens = tokensFor(clue, hard)
  for (const t of tokens) {
    const handle = await page.evaluateHandle(
      (scopeSel, tok) => {
        const btns = [...document.querySelectorAll(`${scopeSel} [data-testid="tiles"] button`)] as HTMLButtonElement[]
        return btns.find((b) => b.dataset.text === tok && !b.disabled) ?? null
      },
      sel(scope),
      t,
    )
    const el = handle.asElement()
    if (!el) throw new Error(`tile "${t}" not found for "${clue}"`)
    await (el as unknown as { click: () => Promise<void> }).click()
    await sleep(wait)
  }
  return true
}

/** Taps a tile that is NOT the next answer token (a wrong tile). */
async function tapWrong(page: Page, scope: string) {
  const clue = await text(page, `${sel(scope)} ${sel('clue')}`)
  const next = tokensFor(clue, false)[0]
  await page.evaluate(
    (scopeSel, tok) => {
      const btns = [...document.querySelectorAll(`${scopeSel} [data-testid="tiles"] button`)] as HTMLButtonElement[]
      const b = btns.find((x) => x.dataset.text !== tok && !x.disabled)
      b?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    },
    sel(scope),
    next,
  )
}

/** Waits for the 3-2-1 to appear (the race may still be starting) and then for GO. */
async function waitGo(page: Page) {
  await page.waitForSelector(sel('countdown'), { timeout: 15000 }).catch(() => {})
  await page.waitForFunction(() => !document.querySelector('[data-testid="countdown"]'), { timeout: 15000 })
  await sleep(150)
}

/** Nothing on the page is cut off or scrolls sideways (kiosk screens must fit the screen). */
async function layoutCheck(page: Page, label: string, opts: { allowVertical?: boolean } = {}) {
  const r = await page.evaluate(() => {
    const d = document.documentElement
    const small = [...document.querySelectorAll('main button:not([disabled]), main [role="button"], [data-testid="tiles"] button')]
      .map((b) => b.getBoundingClientRect())
      .filter((b) => b.width > 0 && b.height > 0 && (b.height < 55.5 || b.width < 55.5))
    return { sw: d.scrollWidth, sh: d.scrollHeight, vw: innerWidth, vh: innerHeight, small: small.length }
  })
  check(`${label}: no sideways scroll`, r.sw <= r.vw + 1, `${r.sw} vs ${r.vw}`)
  if (!opts.allowVertical) check(`${label}: fits the screen`, r.sh <= r.vh + 1, `${r.sh} vs ${r.vh}`)
  check(`${label}: touch targets ≥ 56 px`, r.small === 0, `${r.small} too small`)
}

/** Every kiosk / phone is its own device: a separate browser context (own localStorage and device id). */
async function kiosk(browser: Browser, w = 1920, h = 1080): Promise<Page> {
  const page = await (await browser.createBrowserContext()).newPage()
  await page.setViewport({ width: w, height: h })
  page.on('pageerror', (e) => check(`no page errors (${w}×${h})`, false, String(e)))
  page.on('dialog', (d) => {
    check(`no pop-up dialogs (${w}×${h})`, false, d.message())
    void d.dismiss()
  })
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
  // The ~1 s splash fades into the home page by itself.
  await page.waitForFunction(() => !document.querySelector('[data-testid="splash"]'), { timeout: 8000 })
  return page
}

/** A registration: Project (with a project name) or Business (with an OPU). */
type Reg = { name: string; project?: string; opu?: string }

const OPUS = [
  'Downstream - MRCSB',
  'Downstream - PC MTBE',
  'Downstream - PCEPE',
  'Downstream - PCFKSB',
  'Downstream - PCGCo',
  'Downstream - PCMSB',
  'Downstream - PCOGD',
  'Downstream - PDB',
  'Downstream - PETCO',
  'Downstream - PLISB',
  'Downstream - PP(T)SB',
  'Downstream - PRPC Group',
  'Gas & Maritime - MLNG',
  'Gas & Maritime - PGB GPU',
  'PE&T - GPE',
  'PE&T - PDSB',
  'PE&T - PRSB',
  'Upstream - MPM',
  'Upstream - PMA',
  'Upstream - SBA',
  'Upstream - SKA',
  'Others',
]

/** Home page → Tap to Begin → registration → Start → How to Play → Ready (Solo). */
async function startSolo(page: Page, r: Reg) {
  await waitFor(page, 'home')
  await click(page, 'tap-to-begin')
  await waitFor(page, 'solo-register')
  await register(page, r)
  await click(page, 'start')
  await waitFor(page, 'howto')
  await click(page, 'ready')
}

async function phone(browser: Browser, hash: string): Promise<Page> {
  const page = await (await browser.createBrowserContext()).newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  page.on('pageerror', (e) => check('no page errors (phone)', false, String(e)))
  page.on('dialog', (d) => {
    check('no pop-up dialogs (phone)', false, d.message())
    void d.dismiss()
  })
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'networkidle2' })
  return page
}

/** The Project / Business toggles slide the next field in (≈0.2 s; switching = out + in). */
const SLIDE_MS = 500

/** Opens the OPU bottom sheet and taps an option. */
async function pickOpu(page: Page, prefix: string, opu: string) {
  await click(page, `${prefix}opu`)
  await page.waitForSelector('[data-testid="opu-sheet"][data-ready="true"]', { visible: true, timeout: 5000 })
  const handle = await page.evaluateHandle((o) => [...document.querySelectorAll('[data-testid="opu-option"]')].find((b) => (b as HTMLElement).dataset.value === o) ?? null, opu)
  const el = handle.asElement()
  if (!el) throw new Error(`OPU option "${opu}" not found`)
  await (el as unknown as { click: () => Promise<void> }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="opu-sheet"]'), { timeout: 5000 })
}

async function register(page: Page, r: Reg, prefix = '') {
  await typeInto(page, sel(`${prefix}full-name`), r.name)
  if (r.opu) {
    await click(page, `${prefix}from-business`)
    await sleep(SLIDE_MS)
    await pickOpu(page, prefix, r.opu)
  } else {
    await click(page, `${prefix}from-project`)
    await sleep(SLIDE_MS)
    await typeInto(page, sel(`${prefix}project-name`), r.project ?? 'Kasawari CCS')
  }
  const checked = await page.$eval(sel(`${prefix}consent`), (e) => (e as HTMLInputElement).checked)
  if (!checked) await page.$eval(sel(`${prefix}consent`), (e) => (e as HTMLInputElement).click())
}

/** Computed style values of the first element matching `selector`. */
async function styleOf(page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  return page.$eval(
    selector,
    (e, ps) => {
      const cs = getComputedStyle(e)
      return Object.fromEntries((ps as string[]).map((p) => [p, cs.getPropertyValue(p)]))
    },
    props,
  )
}

const ariaDisabled = (page: Page, id: string) => page.$eval(sel(id), (e) => e.getAttribute('aria-disabled'))

/** No "Nerv Centre" / "Nerv Center" anywhere a visitor can read or hear it (text, title, alt, labels, placeholders, meta). The NERVCENTRE logo stays. */
async function noNervCentre(page: Page, label: string) {
  const found = await page.evaluate(() => {
    const re = /Nerv\s+Cent(re|er)/i
    const attrs = ['alt', 'title', 'aria-label', 'placeholder']
    const bits = [
      document.title,
      document.body.innerText,
      document.querySelector('meta[name="description"]')?.getAttribute('content') ?? '',
      ...[...document.querySelectorAll('[alt],[title],[aria-label],[placeholder]')].flatMap((e) => attrs.map((a) => e.getAttribute(a) ?? '')),
    ]
    return bits.flatMap((b) => {
      const m = re.exec(b)
      return m ? [b.slice(Math.max(0, m.index - 30), m.index + 40)] : []
    })
  })
  check(`no "Nerv Centre" text: ${label}`, found.length === 0, found.join(' | '))
}

/** Scrolls a feedback control to the middle first (as a visitor would), so the sticky See My Result bar never covers it. */
async function tap(page: Page, id: string) {
  const el = await waitFor(page, id)
  await el!.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  await el!.click()
}

/** Answers the three feedback questions (one tap each) and taps See My Result. */
async function answerFeedback(page: Page, opts: { q1?: boolean; q2?: boolean; stars?: number; chips?: string[] } = {}) {
  await waitFor(page, 'feedback-form', 20000)
  await tap(page, `q1-${opts.q1 === false ? 'no' : 'yes'}`)
  await tap(page, `q2-${opts.q2 === false ? 'no' : 'yes'}`)
  if (opts.q2 !== false) {
    await sleep(350)
    for (const c of opts.chips ?? []) await tap(page, `chip-${c}`)
  }
  await tap(page, `q3-star-${opts.stars ?? 4}`)
  await tap(page, 'feedback-submit')
}

/** Feedback screen sizes from the brief: Yes/No ≥ 56 px, stars and chips ≥ 44 px, nothing sideways, See My Result in view. */
async function feedbackLayout(page: Page, label: string, opts: { fits?: boolean } = {}) {
  // No named functions inside page code: tsx would wrap them in a __name() helper the page doesn't have.
  const r = await page.evaluate(() => {
    const d = document.documentElement
    const scroller = document.querySelector('[data-testid="feedback"]') as HTMLElement | null
    const submit = document.querySelector('[data-testid="feedback-submit"]')!.getBoundingClientRect()
    const form = document.querySelector('[data-testid="feedback-form"]')!
    // On the kiosk the card scrolls inside the frame; on phones the whole page does.
    const cardScroll = form.parentElement!
    return {
      sw: Math.max(d.scrollWidth, scroller?.scrollWidth ?? 0),
      vw: innerWidth,
      vh: innerHeight,
      contentH: scroller ? scroller.scrollHeight : d.scrollHeight,
      cardOverflow: scroller ? 0 : cardScroll.scrollHeight - cardScroll.clientHeight,
      overflowing: [...form.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > innerWidth + 1).length,
      choices: [...document.querySelectorAll('.fb-choice')].map((e) => Math.round(e.getBoundingClientRect().height)),
      stars: [...document.querySelectorAll('.fb-star')].map((e) => Math.round(Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height))),
      chips: [...document.querySelectorAll('.fb-chip')].map((e) => Math.round(e.getBoundingClientRect().height)),
      submitInView: submit.top >= 0 && submit.bottom <= innerHeight + 1,
      submitH: Math.round(submit.height),
    }
  })
  check(`${label}: no sideways scroll, nothing cut off`, r.sw <= r.vw + 1 && r.overflowing === 0, `${r.sw} vs ${r.vw}, ${r.overflowing} overflowing`)
  check(`${label}: Yes / No buttons ≥ 56 px tall`, r.choices.length === 4 && r.choices.every((h) => h >= 56), r.choices.join())
  check(`${label}: stars ≥ 44 px`, r.stars.length === 5 && r.stars.every((h) => h >= 44), r.stars.join())
  if (r.chips.length) check(`${label}: chips ≥ 44 px`, r.chips.every((h) => h >= 44), r.chips.join())
  check(`${label}: See My Result in view (≥ 56 px)`, r.submitInView && r.submitH >= 56, String(r.submitH))
  if (opts.fits) check(`${label}: fits one screen`, r.contentH <= r.vh + 1 && r.cardOverflow <= 1, `${r.contentH} vs ${r.vh}, card overflow ${r.cardOverflow}`)
}

/** Feedback rows for one player in the Feedback CSV export (rehearsal answers are not in it). */
async function feedbackRowsFor(name: string): Promise<number> {
  const csv = await api<string>('/api/admin/feedback/export.csv', { token: adminToken })
  return csv.split('\r\n').filter((l) => l.includes(`"${name}"`)).length
}

// ── Scenarios ───────────────────────────────────────────────────────────────

async function adminFirstLogin(browser: Browser) {
  section('Admin – first login forces a new PIN')
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle2' })
  await typeInto(page, sel('admin-pin'), '1234')
  await click(page, 'admin-login-submit')
  check('admin: default PIN leads to "choose your own PIN"', await has(page, 'change-pin'))
  await typeInto(page, sel('pin-current'), '1234')
  await typeInto(page, sel('pin-new'), '123456')
  await typeInto(page, sel('pin-again'), '123456')
  await click(page, 'pin-save')
  check('admin: weak PIN refused', /straight run/i.test(await text(page, sel('change-pin'))))
  await typeInto(page, sel('pin-new'), NEW_PIN)
  await typeInto(page, sel('pin-again'), NEW_PIN)
  await click(page, 'pin-save')
  check('admin: dashboard after the PIN change', await has(page, 'dashboard', 8000))
  check('admin: Back to Home in the sidebar and header', (await has(page, 'admin-back-home')) && (await has(page, 'admin-header-home')))
  await shot(page, '02-admin')
  await click(page, 'admin-header-home')
  check('admin: Back to Home opens the home page', await has(page, 'home', 6000))
  const login = await api<{ token: string }>('/api/admin/login', { json: { pin: NEW_PIN } })
  adminToken = login.token
  await refreshSolutions()
  await page.close()
}

async function soloFlow(browser: Browser) {
  section('Phase 1 – Solo Rush from the PMX home page (1920×1080)')
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 1920, height: 1080 })
  page.on('pageerror', (e) => check('no page errors (1920×1080)', false, String(e)))
  await page.goto(`${BASE}/#/`, { waitUntil: 'networkidle2' })
  check('splash: ~1 s logo splash on opening', await has(page, 'splash', 2000))
  await noNervCentre(page, 'splash')
  await shot(page, '00-splash')
  await page.waitForFunction(() => !document.querySelector('[data-testid="splash"]'), { timeout: 8000 })
  await waitFor(page, 'home')
  check('home: "PMX Digital Challenge" title', /PMX Digital Challenge/.test(await text(page, sel('home-title'))))
  check('home: PETRONAS + NERVCENTRE logos', (await page.$('[data-testid="partner-logos"] img[alt="PETRONAS"]')) !== null && (await page.$('[data-testid="partner-logos"] img[alt="NERVCENTRE"]')) !== null)
  check('home: big "Tap to Begin" button', /Tap to Begin/.test(await text(page, sel('tap-to-begin'))))
  check('home: no registration fields on the home page', (await page.$(sel('full-name'))) === null)
  check('home: Multiplayer Battle and Head-to-Head buttons', (await page.$(sel('mode-battle'))) !== null && (await page.$(sel('mode-h2h'))) !== null)
  await noNervCentre(page, 'home')
  await shot(page, '01-home')
  await layoutCheck(page, 'home 1920×1080')

  // Tap to Begin → the registration form (white card).
  await click(page, 'tap-to-begin')
  await waitFor(page, 'solo-register')
  const card = sel('registration')
  check('register: white card', (await styleOf(page, card, ['background-color']))['background-color'] === 'rgb(255, 255, 255)')
  check('register: Full name + "You are from" Project / Business', (await page.$(sel('full-name'))) !== null && /You are from/.test(await text(page, card)) && (await page.$(sel('from-project'))) !== null && (await page.$(sel('from-business'))) !== null)
  const checkedStates = await page.$$eval('[role="radio"]', (els) => els.map((e) => e.getAttribute('aria-checked')))
  check('register: nothing pre-selected', checkedStates.join() === 'false,false' && (await page.$(sel('conditional'))) === null, checkedStates.join())
  check('register: PDPA consent text', (await text(page, card)).includes('I agree my name and project/OPU will be recorded for this event and shown on the leaderboard.'))
  check('register: Start disabled until the form is valid', (await ariaDisabled(page, 'start')) === 'true')
  const startStyle = await styleOf(page, sel('start'), ['background-color', 'color'])
  check('register: Start is Green #00A19C with white text', startStyle['background-color'] === 'rgb(0, 161, 156)' && startStyle.color === 'rgb(255, 255, 255)', JSON.stringify(startStyle))
  const offStyle = await styleOf(page, sel('from-project'), ['background-color', 'border-top-color'])
  check('register: unselected toggle is white with a #D9E1EA border', offStyle['background-color'] === 'rgb(255, 255, 255)' && offStyle['border-top-color'] === 'rgb(217, 225, 234)', JSON.stringify(offStyle))
  const toggleH = await page.$$eval('[role="radio"]', (els) => els.map((e) => e.getBoundingClientRect().height))
  check('register: Project / Business toggles ≥ 56 px tall', toggleH.every((h) => h >= 56), toggleH.join())
  await noNervCentre(page, 'registration')
  await shot(page, '03a-register-empty')

  // Tapping the disabled Start shows every problem inline under its field (never a pop-up).
  await click(page, 'start')
  await sleep(200)
  check('validation: "Please enter your full name."', (await text(page, sel('full-name-error'))) === 'Please enter your full name.')
  check('validation: "Please select Project or Business."', (await text(page, sel('from-error'))) === 'Please select Project or Business.')
  check('validation: consent required', /consent/i.test(await text(page, sel('consent-error'))))
  const errStyle = await styleOf(page, sel('full-name-error'), ['color'])
  check('validation: errors in red #D83B3E with an icon', errStyle.color === 'rgb(216, 59, 62)' && (await page.$(`${sel('full-name-error')} svg`)) !== null, errStyle.color)
  check('validation: Start did nothing while invalid', await has(page, 'solo-register', 500))
  await shot(page, '03b-register-errors')

  // Full-name rules (checked when leaving the field).
  const nameError = async (v: string) => {
    await typeInto(page, sel('full-name'), v)
    await page.$eval(sel('full-name'), (e) => (e as HTMLInputElement).blur())
    await sleep(120)
    return text(page, sel('full-name-error'))
  }
  for (const bad of ['12345', '!!!', 'A', 'Ali 2']) check(`validation: name "${bad}" refused`, (await nameError(bad)) === 'Please enter your full name.')
  for (const good of ['Ravi a/l Kumar', "Nur 'Ain binti Ahmad", 'Mary-Ann O. Lee']) check(`validation: name "${good}" accepted`, (await nameError(good)) === '')
  await nameError('Firdaus Zahin')
  await page.focus(sel('full-name'))
  await sleep(250)
  check('register: focused input has a Soft Green border', (await styleOf(page, sel('full-name'), ['border-top-color']))['border-top-color'] === 'rgb(191, 215, 48)')

  // Project → the Project name field slides / fades in directly below the toggles.
  // Samples the field's opacity every frame while it appears. Passed as a string: tsx wraps named functions in a
  // __name() helper that does not exist inside the page.
  const anim = (await page.evaluate(`(async () => {
    const seen = []
    let stop = false
    function sample() {
      const c = document.querySelector('[data-testid="conditional"]')
      if (c) seen.push(Number(getComputedStyle(c).opacity))
      if (!stop) requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
    document.querySelector('[data-testid="from-project"]').click()
    await new Promise((r) => setTimeout(r, 700))
    stop = true
    return { min: Math.min(...seen), last: seen[seen.length - 1] ?? 0, frames: seen.length }
  })()`)) as { min: number; last: number; frames: number }
  check('Project: the Project name field fades in', anim.frames > 2 && anim.min < 0.9 && anim.last === 1, JSON.stringify(anim))
  const pos = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="from-project"]')!.getBoundingClientRect()
    const f = document.querySelector('[data-testid="project-name"]')!.getBoundingClientRect()
    const c = document.querySelector('[data-testid="consent"]')!.closest('label')!.getBoundingClientRect()
    return { gap: Math.round(f.top - t.bottom), aboveConsent: f.bottom <= c.top }
  })
  check('Project: field appears directly below the toggles', pos.gap >= 0 && pos.gap < 120 && pos.aboveConsent, JSON.stringify(pos))
  const onStyle = await styleOf(page, sel('from-project'), ['background-color', 'color'])
  check(
    'Project: selected toggle is Soft Green with dark navy text and a check icon',
    onStyle['background-color'] === 'rgb(191, 215, 48)' && onStyle.color === 'rgb(11, 22, 56)' && (await page.$(`${sel('from-project')} svg.lucide-check`)) !== null,
    JSON.stringify(onStyle),
  )
  check('Project: Business stays unselected', (await page.$eval(sel('from-business'), (e) => e.getAttribute('aria-checked'))) === 'false')
  check('Project: focus moves to Project name', await page.$eval(sel('project-name'), (e) => document.activeElement === e))
  await shot(page, '03c-register-project')

  // Project name rules: required, then the server's blocked-word check – inline either way.
  await page.$eval(sel('consent'), (e) => (e as HTMLInputElement).click())
  check('register: Start stays disabled without a project name', (await ariaDisabled(page, 'start')) === 'true')
  await click(page, 'start')
  await sleep(150)
  check('validation: "Please enter your project name."', (await text(page, sel('project-name-error'))) === 'Please enter your project name.')
  await typeInto(page, sel('project-name'), 'babi')
  check('register: Start enabled once the form is valid', (await ariaDisabled(page, 'start')) === 'false')
  await click(page, 'start')
  await sleep(700)
  check('validation: blocked word refused by the server, shown inline', (await text(page, sel('project-name-error'))) === 'Please enter your project name.' && (await has(page, 'solo-register', 500)))

  // Business → OPU picker (bottom sheet); switching clears the other field.
  await typeInto(page, sel('project-name'), 'Kasawari CCS')
  await click(page, 'from-business')
  await sleep(SLIDE_MS)
  check('Business: Project name replaced by the OPU picker', (await page.$(sel('project-name'))) === null && (await has(page, 'opu', 2000)))
  check('Business: Start disabled until an OPU is chosen', (await ariaDisabled(page, 'start')) === 'true')
  await click(page, 'start')
  await sleep(150)
  check('validation: "Please select your OPU."', (await text(page, sel('opu-error'))) === 'Please select your OPU.')
  await click(page, 'opu')
  await page.waitForSelector('[data-testid="opu-sheet"][data-ready="true"]', { visible: true, timeout: 5000 })
  const opts = await page.$$eval('[data-testid="opu-option"]', (els) => els.map((e) => ({ t: (e as HTMLElement).dataset.value ?? '', h: e.getBoundingClientRect().height })))
  check(`OPU sheet: all ${OPUS.length} OPUs in the required order (incl. "Others")`, JSON.stringify(opts.map((o) => o.t)) === JSON.stringify(OPUS), opts.map((o) => o.t).join(' | '))
  const headings = await page.$$eval('[data-testid="opu-group"]', (els) => els.map((e) => (e.querySelector('[id]') as HTMLElement | null)?.innerText.trim() ?? '(none)'))
  check('OPU sheet: grouped under Downstream, Gas & Maritime, PE&T, Upstream, then Others', headings.join('|') === 'DOWNSTREAM|GAS & MARITIME|PE&T|UPSTREAM|(none)', headings.join(' | '))
  const shortLabel = await page.$eval('[data-testid="opu-option"][data-value="Downstream - MRCSB"]', (e) => (e as HTMLElement).innerText.trim())
  check('OPU sheet: options show the short name under their heading', shortLabel === 'MRCSB', shortLabel)
  check('OPU sheet: large touch-friendly options (≥ 56 px)', opts.every((o) => o.h >= 56), opts.map((o) => Math.round(o.h)).join())
  await shot(page, '03d-opu-sheet')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('[data-testid="opu-sheet"]'), { timeout: 5000 })
  check('OPU sheet: Esc closes it without choosing', /Select your OPU/.test(await text(page, sel('opu'))))
  await pickOpu(page, '', 'Downstream - PRPC Group')
  check('Business: the chosen OPU is shown in full', /Downstream - PRPC Group/.test(await text(page, sel('opu'))))
  check('Business: Start enabled', (await ariaDisabled(page, 'start')) === 'false')
  await shot(page, '03e-register-business')
  await click(page, 'from-project')
  await sleep(SLIDE_MS)
  check('switching: the earlier project name was cleared', (await page.$eval(sel('project-name'), (e) => (e as HTMLInputElement).value)) === '')
  await click(page, 'from-business')
  await sleep(SLIDE_MS)
  check('switching: the earlier OPU was cleared', /Select your OPU/.test(await text(page, sel('opu'))))

  // Project path for this player; consent is required.
  await click(page, 'from-project')
  await sleep(SLIDE_MS)
  await typeInto(page, sel('project-name'), 'Kasawari CCS')
  await page.$eval(sel('consent'), (e) => (e as HTMLInputElement).click())
  check('consent: Start disabled without consent', (await ariaDisabled(page, 'start')) === 'true')
  await page.$eval(sel('consent'), (e) => (e as HTMLInputElement).click())
  check('consent: Start enabled with consent', (await ariaDisabled(page, 'start')) === 'false')
  await shot(page, '03-register')
  await layoutCheck(page, 'registration 1920×1080')
  check('registration 1920×1080: whole card on screen', await page.$eval(card, (e) => e.getBoundingClientRect().bottom <= innerHeight))
  await click(page, 'start')

  await waitFor(page, 'howto')
  check('how to play: 3 steps', (await page.$$(`${sel('howto')} .panel`)).length === 3)
  await shot(page, '04-howto')
  await layoutCheck(page, 'how to play')
  await noNervCentre(page, 'how to play')
  await click(page, 'ready')

  await waitFor(page, 'countdown')
  check('3-2-1-GO countdown shown', true)
  await shot(page, '05-countdown')
  await waitGo(page)
  await shot(page, '06-game')
  await layoutCheck(page, 'solo game')
  await noNervCentre(page, 'game')
  check('game: Project / OPU under the name', /Kasawari CCS/.test(await text(page, sel('solo-race'))))
  const timer1 = await text(page, sel('timer'))
  check('timer: yellow big clock counting down', /\d+\.\d\d/.test(timer1), timer1)

  // Wrong tile → shake + penalty
  await tapWrong(page, 'solo-race')
  await sleep(120)
  check('wrong tile: red shake', (await page.$('.tile-wrong')) !== null)
  check('wrong tile: "+1 s" shown', /\+1 s/.test(await text(page, sel('solo-race'))))
  await shot(page, '07-wrong')
  // Skip
  await sleep(500)
  const clueBefore = await text(page, sel('clue'))
  await click(page, 'skip')
  await sleep(200)
  check('skip: next solution shown, +2 s', (await text(page, sel('clue'))) !== clueBefore && /\+2 s/.test(await text(page, sel('solo-race'))))

  let solved = 0
  for (let i = 0; i < 6; i++) {
    if (!(await solveCurrent(page, 'solo-race'))) break
    solved++
    await sleep(150)
    if (i === 2) {
      check('constellation: stars light up as names are built', /3 of 6 stars lit/.test((await page.$eval('[aria-label$="stars lit"]', (e) => e.getAttribute('aria-label')).catch(() => '')) ?? ''))
      await shot(page, '08-three-stars')
    }
  }
  check('solo: all 6 solutions built', solved === 6, `${solved}`)
  await waitFor(page, 'reveal', 8000)
  await sleep(2600)
  check('reveal: full constellation + logo', (await page.$eval(sel('reveal'), (e) => e.getAttribute('data-complete'))) === 'yes')
  await noNervCentre(page, 'reveal')
  await shot(page, '09-reveal')

  // Feedback: after the game, before the result card – and the score is already saved.
  await waitFor(page, 'feedback-form', 15000)
  check('feedback: shown after the game and before the result card', (await page.$(sel('results'))) === null)
  const savedRuns = await api<{ name: string; solved: number }[]>('/api/admin/runs?day=today', { token: adminToken })
  check('feedback: the score is already in the database', savedRuns.some((r) => r.name === 'Firdaus Zahin' && r.solved === 6))
  const fbText = await text(page, sel('feedback-form'))
  check(
    'feedback: heading, intro and the three questions',
    /Your score is ready/.test(fbText) && /Answer 3 quick questions to see your result/.test(fbText) && /relevant to your project or business needs/.test(fbText) &&
      /adopting or exploring any of the solutions showcased/.test(fbText) && /better understand the available digital solutions/.test(fbText),
    fbText.replace(/\s+/g, ' ').slice(0, 200),
  )
  check('feedback: no Home / Back button and no countdown', (await page.$(sel('home-button'))) === null && (await page.$(sel('back'))) === null && (await page.$(sel('timer'))) === null && !/Back to the home page in/.test(await text(page, 'body')))
  const pageStyle = await styleOf(page, sel('feedback-form'), ['background-color', 'font-family'])
  check('feedback: #F5F7FA background, Nunito', pageStyle['background-color'] === 'rgb(245, 247, 250)' && /Nunito/.test(pageStyle['font-family']), JSON.stringify(pageStyle))
  check('feedback: heading in Blue #20419A', (await styleOf(page, `${sel('feedback-form')} h1`, ['color'])).color === 'rgb(32, 65, 154)')
  const submitState = () => page.$eval(sel('feedback-submit'), (e) => ({ disabled: (e as HTMLButtonElement).disabled, bg: getComputedStyle(e).backgroundColor, color: getComputedStyle(e).color, anim: getComputedStyle(e).animationName }))
  check('feedback: See My Result disabled and grey at first', (await submitState()).disabled && (await submitState()).bg === 'rgb(217, 225, 234)', JSON.stringify(await submitState()))
  const offChoice = await styleOf(page, sel('q1-yes'), ['background-color', 'border-top-color'])
  check('feedback: unselected = white with a #D9E1EA border', offChoice['background-color'] === 'rgb(255, 255, 255)' && offChoice['border-top-color'] === 'rgb(217, 225, 234)', JSON.stringify(offChoice))
  await tap(page, 'q1-yes')
  await sleep(300) // colours fade in over 0.15 s
  const onChoice = await styleOf(page, sel('q1-yes'), ['background-color', 'color'])
  check(
    'feedback: selected = Soft Green, dark navy text, ✓',
    onChoice['background-color'] === 'rgb(191, 215, 48)' && onChoice.color === 'rgb(11, 22, 56)' && (await page.$(`${sel('q1-yes')} svg.lucide-check`)) !== null,
    JSON.stringify(onChoice),
  )
  await tap(page, 'q1-no')
  check('feedback: an answer can be changed', (await page.$eval(sel('q1-no'), (e) => e.getAttribute('aria-checked'))) === 'true' && (await page.$eval(sel('q1-yes'), (e) => e.getAttribute('aria-checked'))) === 'false')
  await tap(page, 'q1-yes')
  check('feedback: still disabled after Q1 only', (await submitState()).disabled)
  check('feedback: no solution chips before Q2 = Yes', (await page.$(sel('q2-chips'))) === null)
  await tap(page, 'q2-yes')
  await sleep(450)
  const chipIds = await page.$$eval('[data-testid^="chip-"]', (els) => els.map((e) => (e as HTMLElement).dataset.testid!.slice(5)))
  check('feedback: Q2 = Yes slides in a chip for every solution (from Admin)', JSON.stringify(chipIds) === JSON.stringify(solutions.map((s) => s.id)), chipIds.join())
  await tap(page, `chip-${solutions[0].id}`)
  await tap(page, `chip-${solutions[2].id}`)
  const ticked = () => page.$$eval('[data-testid^="chip-"][aria-checked="true"]', (els) => els.length)
  check('feedback: chips are multi-select', (await ticked()) === 2)
  await tap(page, 'q2-no')
  await sleep(450)
  check('feedback: chips leave when Q2 switches to No', (await page.$(sel('q2-chips'))) === null)
  await tap(page, 'q2-yes')
  await sleep(450)
  check('feedback: switching to No cleared the chips', (await ticked()) === 0)
  await tap(page, `chip-${solutions[1].id}`)
  check('feedback: still disabled until Q3', (await submitState()).disabled)
  await tap(page, 'q3-star-2')
  check('feedback: star label "A little" for 2', (await text(page, sel('q3-label'))) === 'A little')
  await tap(page, 'q3-star-4')
  await sleep(450)
  const starState = await page.$$eval('.fb-star', (els) => els.map((e) => ({ on: e.getAttribute('data-on'), fill: getComputedStyle(e.querySelector('svg')!).fill })))
  check(
    'feedback: 4 stars filled Yellow #FDB924, label "Yes"',
    starState.filter((s) => s.on === 'true').length === 4 && starState[0].fill === 'rgb(253, 185, 36)' && (await text(page, sel('q3-label'))) === 'Yes',
    JSON.stringify(starState[0]),
  )
  const ready = await submitState()
  check('feedback: See My Result active – Green #00A19C, white text, gentle pulse', !ready.disabled && ready.bg === 'rgb(0, 161, 156)' && ready.color === 'rgb(255, 255, 255)' && ready.anim === 'fb-pulse', JSON.stringify(ready))
  await feedbackLayout(page, 'feedback 1920×1080', { fits: true })
  await noNervCentre(page, 'feedback')
  await shot(page, '11-feedback')
  // A double tap sends once: the first tap disables the button and shows a spinner. (A string, so tsx adds no __name().)
  const taps = (await page.evaluate(`new Promise((resolve) => {
    const b = document.querySelector('[data-testid="feedback-submit"]')
    const seen = { disabled: false, busy: false, spinner: false }
    const mo = new MutationObserver(() => {
      if (b.disabled) seen.disabled = true
      if (b.getAttribute('aria-busy') === 'true') seen.busy = true
      if (b.querySelector('.fb-spinner')) seen.spinner = true
    })
    mo.observe(b, { attributes: true, childList: true, subtree: true })
    b.click()
    b.click()
    setTimeout(() => { mo.disconnect(); resolve(seen) }, 60)
  })`)) as { disabled: boolean; busy: boolean; spinner: boolean }
  check('feedback: after the first tap – disabled with a spinner', taps.disabled && taps.busy && taps.spinner, JSON.stringify(taps))

  await waitFor(page, 'results', 10000)
  check('feedback: stored once', (await feedbackRowsFor('Firdaus Zahin')) === 1)
  await page.waitForFunction(() => document.querySelector('[data-testid="title"]'), { timeout: 10000 })
  check('results: NC Master title', /NC Master/.test(await text(page, sel('title'))))
  check('results: time to 0.01 s', /\d+\.\d\d s/.test(await text(page, sel('result-time'))))
  check('results: 6/6 stars', /6\/6/.test(await text(page, sel('result-solved'))))
  check('results: rank today #1', /#1/.test(await text(page, sel('result-rank'))))
  check('results: one-line recap for each solution', (await page.$$(`${sel('recap')} li`)).length === 6)
  check('results: penalties counted (1 wrong + 1 skip = +3 s)', /\+3\.00 s/.test(await text(page, sel('result-penalty'))))
  await shot(page, '10-results')
  await layoutCheck(page, 'results', { allowVertical: true })
  await noNervCentre(page, 'results')
  await click(page, 'continue')
  await waitFor(page, 'leaderboard')
  await sleep(400)
  check('leaderboard: this player highlighted', await has(page, 'board-me'))
  const boardText = await text(page, sel('board-today'))
  check('leaderboard: Rank, Name, Project / OPU, Solved, Time', /Rank[\s\S]*Name[\s\S]*Project \/ OPU[\s\S]*Solved[\s\S]*Time/i.test(boardText))
  check('leaderboard: "Department" column is gone', !/Department/i.test(boardText))
  check('leaderboard: player shows their project name', /Firdaus Zahin[\s\S]*Kasawari CCS/.test(await text(page, sel('board-me'))), await text(page, sel('board-me')))
  check('leaderboard: Back to Home + Home buttons', /Back to Home/.test(await text(page, sel('done'))) && (await has(page, 'home-button')))
  await noNervCentre(page, 'leaderboard')
  await shot(page, '12-leaderboard')
  await layoutCheck(page, 'leaderboard', { allowVertical: true })
  await click(page, 'done')
  await waitFor(page, 'home')
  await sleep(500)
  const top5 = await text(page, sel('home-top5'))
  check('home: Top Players shows name and project / OPU', /Firdaus Zahin/.test(top5) && /Kasawari CCS/.test(top5))
  // View Leaderboard from the home page, then the Home button brings you back.
  await click(page, 'view-leaderboard')
  await waitFor(page, 'leaderboard')
  await click(page, 'home-button')
  check('leaderboard: Home button returns to the home page', await has(page, 'home', 4000))
  await shot(page, '13-home-after')

  // Play again the same day: no second feedback – straight to the result card.
  await startSolo(page, { name: 'Firdaus Zahin', project: 'Kasawari CCS' })
  await waitGo(page)
  for (let i = 0; i < 6; i++) if (!(await solveCurrent(page, 'solo-race'))) break
  await waitFor(page, 'reveal', 8000)
  await page.evaluate(() => {
    const w = window as unknown as { __sawFeedback: boolean }
    w.__sawFeedback = false
    new MutationObserver(() => {
      if (document.querySelector('[data-testid="feedback-form"]')) w.__sawFeedback = true
    }).observe(document.body, { childList: true, subtree: true })
  })
  await waitFor(page, 'results', 15000)
  check('play again (same player, same day): straight to the result card', !(await page.evaluate(() => (window as unknown as { __sawFeedback: boolean }).__sawFeedback)))
  check('play again: still one feedback answer', (await feedbackRowsFor('Firdaus Zahin')) === 1)
  await click(page, 'continue')
  await waitFor(page, 'leaderboard')
  await page.close()
}

/** Both registration paths (Project and Business) at 1920×1080 and on tablets, landscape and portrait. */
async function registrationPaths(browser: Browser) {
  section('Registration – Project and Business paths on 1920×1080 and tablets')
  const runs: [number, number, Reg][] = [
    [1920, 1080, { name: 'Nur Aisyah binti Ahmad', opu: 'PE&T - GPE' }],
    [1024, 768, { name: 'Ravi a/l Kumar', project: 'Jerun Phase 2' }],
    [1024, 768, { name: 'Siti Aminah', opu: 'Upstream - MPM' }],
    [768, 1024, { name: 'Devi a/p Muniandy', project: 'PFLNG 3' }],
    [768, 1024, { name: "Nur 'Ain binti Ahmad", opu: 'Others' }],
  ]
  for (const [w, h, r] of runs) {
    const label = `${r.opu ? 'Business' : 'Project'} ${w}×${h}`
    const portrait = h > w
    const page = await kiosk(browser, w, h)
    await click(page, 'tap-to-begin')
    await waitFor(page, 'solo-register')
    if (r.opu) {
      // Show the OPU sheet on this screen size first.
      await click(page, 'from-business')
      await sleep(SLIDE_MS)
      await click(page, 'opu')
      await page.waitForSelector('[data-testid="opu-sheet"][data-ready="true"]', { visible: true, timeout: 5000 })
      const sheet = await page.$eval(sel('opu-sheet'), (e) => {
        const b = e.getBoundingClientRect()
        const opts = [...e.querySelectorAll('[data-testid="opu-option"]')].map((o) => o.getBoundingClientRect())
        return { fits: b.top >= 0 && b.bottom <= innerHeight + 1, small: opts.filter((o) => o.height < 56).length, count: opts.length }
      })
      check(`OPU sheet (${w}×${h}): all ${OPUS.length} options, ≥ 56 px, on screen`, sheet.count === OPUS.length && sheet.small === 0 && sheet.fits, JSON.stringify(sheet))
      await shot(page, `03f-opu-sheet-${w}x${h}`)
      await click(page, 'opu-sheet-close')
      await page.waitForFunction(() => !document.querySelector('[data-testid="opu-sheet"]'), { timeout: 5000 })
    }
    await register(page, r)
    check(`registration (${label}): Start enabled when valid`, (await ariaDisabled(page, 'start')) === 'false')
    await layoutCheck(page, `registration (${label})`, { allowVertical: portrait })
    if (!portrait) check(`registration (${label}): whole card on screen`, await page.$eval(sel('registration'), (e) => e.getBoundingClientRect().bottom <= innerHeight))
    await shot(page, `03g-register-${w}x${h}-${r.opu ? 'business' : 'project'}`)
    await click(page, 'start')
    check(`registration (${label}): reaches How to Play`, await has(page, 'howto', 6000))
    check(`registration (${label}): name shown`, (await text(page, sel('howto-screen'))).includes(r.name))
    await page.close()
  }
}

async function refreshAndTimeUp(browser: Browser) {
  section('Phase 1 – refresh can\'t reset a game; time-up path (Business player)')
  const page = await kiosk(browser, 1280, 800)
  await layoutCheck(page, 'home 1280×800')
  await startSolo(page, { name: 'Aina Rahman', opu: 'Upstream - PMA' })
  await waitGo(page)
  await layoutCheck(page, 'solo game 1280×800')
  await solveCurrent(page, 'solo-race')
  await solveCurrent(page, 'solo-race')
  await sleep(300)
  const before = await text(page, sel('timer'))
  await page.reload({ waitUntil: 'networkidle2' })
  await waitFor(page, 'solo-race', 10000)
  await sleep(600)
  const lit = await page.$eval('aside [aria-label$="stars lit"]', (e) => e.getAttribute('aria-label')).catch(() => '')
  const after = await text(page, sel('timer'))
  const secs = (s: string) => Number(/(\d+\.\d\d)/.exec(s)?.[1] ?? 0)
  check('refresh: game resumes with its progress (2 stars)', /2 of 6/.test(lit ?? ''), lit ?? '')
  check('refresh: the clock kept running on the server', secs(after) < secs(before) && secs(after) > 0, `${before} → ${after}`)
  // Let the clock run out (≈ 30 s).
  await waitFor(page, 'reveal', 40000)
  check('time up: reveal shows a partial constellation', (await page.$eval(sel('reveal'), (e) => e.getAttribute('data-complete'))) === 'no')
  await waitFor(page, 'feedback-form', 15000)
  await feedbackLayout(page, 'feedback 1280×800', { fits: true })
  await answerFeedback(page, { q1: false, q2: false, stars: 2 })
  await waitFor(page, 'results', 10000)
  await page.waitForFunction(() => document.querySelector('[data-testid="title"]'), { timeout: 10000 })
  check('time up: NC Rookie for 2 of 6', /NC Rookie/.test(await text(page, sel('title'))))
  check('time up: "Time used" shown', /Time used/i.test(await text(page, sel('result-time'))))
  check('results: Home button', await has(page, 'home-button'))
  await click(page, 'continue')
  await waitFor(page, 'leaderboard')
  await sleep(400)
  check('leaderboard: Business player shows the OPU', /Aina Rahman[\s\S]*Upstream - PMA/.test(await text(page, sel('board-me'))), await text(page, sel('board-me')))
  await click(page, 'done')
  await page.close()
}

async function adminBasics(browser: Browser) {
  section('Phase 1 – Admin basics: solutions, Hard Mode, remove entries, reset daily board')
  // Edit a clue through the UI
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle2' })
  await typeInto(page, sel('admin-pin'), NEW_PIN)
  await click(page, 'admin-login-submit')
  await click(page, 'admin-tab-solutions')
  await waitFor(page, 'solution-pcc')
  await typeInto(page, `${sel('solution-pcc')} ${sel('sol-clue')}`, 'One central view to monitor and control the whole project')
  await click(page, 'save-solutions')
  await sleep(600)
  await refreshSolutions()
  check('admin: clue edited and saved', solutions.find((s) => s.id === 'pcc')?.clue === 'One central view to monitor and control the whole project')
  await click(page, 'preview-hard')
  await sleep(500)
  const letterTiles = await page.$$eval('[data-testid="solutions-tab"] li span.min-w-8', (els) => els.map((e) => (e as HTMLElement).innerText))
  check('admin: Hard Mode preview shows letter tiles (P T Q …)', ['P', 'T', 'Q', 'A', 'I'].every((l) => letterTiles.includes(l)), letterTiles.join(' '))
  await shot(page, '13-admin-solutions')

  await click(page, 'admin-tab-settings')
  await waitFor(page, 'settings-tab')
  await click(page, 'set-hard')
  await click(page, 'save-settings')
  await sleep(600)

  const k = await kiosk(browser)
  await startSolo(k, { name: 'Hard Mode Hero', project: 'PFLNG 3' })
  await waitGo(k)
  let hardSolved = 0
  for (let i = 0; i < 6; i++) if (await solveCurrent(k, 'solo-race', true)) hardSolved++
  check('Hard Mode: letter tiles appear and can be solved', hardSolved === 6, `${hardSolved}`)
  await answerFeedback(k)
  await waitFor(k, 'results', 15000)
  await k.close()
  await setSettings({ hard_mode: false })

  // Results tab: remove + restore
  await click(page, 'admin-tab-results')
  await waitFor(page, 'runs-table')
  await sleep(500)
  const before = await api<{ today: { name: string }[] }>('/api/boards')
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="runs-table"] tr')].find((r) => (r as HTMLElement).innerText.includes('Hard Mode Hero'))
    ;(row?.querySelector('[data-testid="remove"]') as HTMLButtonElement)?.click()
  })
  await typeInto(page, sel('remove-reason'), 'Staff test game')
  await click(page, 'remove-confirm')
  await sleep(600)
  const after = await api<{ today: { name: string }[] }>('/api/boards')
  check('admin: removed entry leaves the leaderboard', before.today.some((r) => r.name === 'Hard Mode Hero') && !after.today.some((r) => r.name === 'Hard Mode Hero'))
  await shot(page, '14-admin-results')

  await click(page, 'admin-tab-boards')
  await waitFor(page, 'boards-tab')
  await shot(page, '15-admin-boards')
  await page.close()
}

async function battleFlow(browser: Browser) {
  section('Phase 2 – Multiplayer Battle + TV display')
  await setSettings({ public_base_url: `http://127.0.0.1:${PORT}`, timer_seconds: 20, howto_seconds: 3 })
  const display = await browser.newPage()
  await display.setViewport({ width: 1920, height: 1080 })
  await display.goto(`${BASE}/#/display`, { waitUntil: 'networkidle2' })
  await waitFor(display, 'display')
  check('display: Home button', await has(display, 'display-home'))

  const host = await kiosk(browser)
  await click(host, 'mode-battle')
  await waitFor(host, 'lobby')
  const code = (await text(host, sel('room-code'))).trim()
  check('battle: 4-digit room code shown', /^\d{4}$/.test(code), code)
  const qr = await host.$eval('[data-qr-value]', (e) => e.getAttribute('data-qr-value'))
  check('battle: QR code links to the join page', qr === `http://127.0.0.1:${PORT}/#/join/${code}`, qr ?? '')
  await sleep(400)
  check('display: shows the open room code', (await text(display, sel('display-live'))).includes(code))

  const a = await phone(browser, `#/join/${code}`)
  await waitFor(a, 'phone-register')
  check('phone: same registration form (Full name, Project / Business)', (await a.$(sel('full-name'))) !== null && (await a.$(sel('from-project'))) !== null && (await a.$(sel('from-business'))) !== null)
  check('phone: Start disabled until valid', (await ariaDisabled(a, 'start')) === 'true')
  await click(a, 'start')
  await sleep(200)
  check('phone: inline validation', (await text(a, sel('full-name-error'))) === 'Please enter your full name.' && (await text(a, sel('from-error'))) === 'Please select Project or Business.')
  await noNervCentre(a, 'phone registration')
  await register(a, { name: 'Alya Hassan', project: 'Jerun' })
  await a.screenshot({ path: path.join(OUT, '16a-phone-register.png') })
  await layoutCheck(a, 'phone registration', { allowVertical: true })
  await click(a, 'start')
  await waitFor(a, 'phone-lobby')
  const b = await phone(browser, '#/join')
  await waitFor(b, 'code-step')
  await noNervCentre(b, 'phone join code')
  await typeInto(b, sel('room-code-input'), code)
  await click(b, 'code-next')
  await waitFor(b, 'phone-register')
  await click(b, 'from-business')
  await sleep(SLIDE_MS)
  await click(b, 'opu')
  await b.waitForSelector('[data-testid="opu-sheet"][data-ready="true"]', { visible: true, timeout: 5000 })
  const phoneOpts = await b.$$eval('[data-testid="opu-option"]', (els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ h: r.height, w: r.width })))
  check('phone: OPU bottom sheet with large options', phoneOpts.length === OPUS.length && phoneOpts.every((o) => o.h >= 56 && o.w >= 140), JSON.stringify(phoneOpts[0]))
  await b.screenshot({ path: path.join(OUT, '16b-phone-opu-sheet.png') })
  await click(b, 'opu-sheet-close')
  await b.waitForFunction(() => !document.querySelector('[data-testid="opu-sheet"]'), { timeout: 5000 })
  await register(b, { name: 'Badrul Amin', opu: 'Gas & Maritime - MLNG' })
  await click(b, 'start')
  await waitFor(b, 'phone-lobby')
  const c = await phone(browser, `#/join/${code}`)
  await register(c, { name: 'Chong Wei', project: 'GT&C' })
  await click(c, 'start')
  await waitFor(c, 'phone-lobby')
  await sleep(500)
  check('lobby: big screen lists 3 players', (await host.$$(`${sel('lobby-players')} li .font-display`)).length >= 3)
  const lobbyText = await text(host, sel('lobby-players'))
  check('lobby: big screen shows each project name / OPU', /Jerun/.test(lobbyText) && /Gas & Maritime/.test(lobbyText) && /GT&C/.test(lobbyText), lobbyText.replace(/\s+/g, ' ').slice(0, 160))
  check('phone lobby: players with project name / OPU', /Gas & Maritime/.test(await text(a, sel('phone-lobby'))))
  await shot(host, '16-battle-lobby')
  await layoutCheck(host, 'battle lobby')
  await a.screenshot({ path: path.join(OUT, '17-phone-lobby.png') })
  await layoutCheck(a, 'phone lobby', { allowVertical: true })

  // Host removes Chong
  await host.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="lobby-players"] li')].find((r) => (r as HTMLElement).innerText.includes('Chong'))
    ;(row?.querySelector('[data-testid="kick"]') as HTMLButtonElement)?.click()
  })
  await sleep(800)
  check('lobby: host can remove a player', /removed from the room/i.test(await text(c, sel('phone'))) || (await has(c, 'code-step', 3000)))

  await click(host, 'start-battle')
  check('battle: synchronised how-to on the phones', await has(a, 'howto', 5000))
  await waitFor(host, 'battle-race', 10000)
  await waitFor(a, 'phone-game', 10000)
  await waitGo(a)
  await shot(host, '18-battle-race-start')
  const solveScope = 'phone-game'
  await solveCurrent(b, solveScope)
  await solveCurrent(b, solveScope)
  // Badrul's phone drops out – the race continues for Alya.
  const bContext = b.browserContext()
  await b.close()
  await sleep(800)
  check('race view: dropped player shown as disconnected', /Disconnected/i.test(await text(host, sel('race-lanes'))))
  let aSolved = 0
  for (let i = 0; i < 6; i++) if (await solveCurrent(a, solveScope)) aSolved++
  check('battle: player A builds all 6 on the phone', aSolved === 6, `${aSolved}`)
  await sleep(500)
  check('race view: live lanes with progress', (await host.$$(sel('lane'))).length === 2)
  check('race view: lanes show project name / OPU', /Jerun/.test(await text(host, sel('race-lanes'))) && /Gas & Maritime/.test(await text(host, sel('race-lanes'))))
  check('display: live race view', (await display.$$(sel('lane'))).length >= 2)
  await shot(host, '19-battle-race')
  await shot(display, '20-display-race')
  await layoutCheck(host, 'battle race view')
  await layoutCheck(display, 'display')

  // Badrul times out (20 s); then the battle ends.
  await waitFor(host, 'battle-results', 40000)
  check('battle results: Alya wins', /Alya Hassan wins/.test(await text(host, sel('battle-results'))))
  await shot(host, '21-battle-results')
  await waitFor(a, 'reveal', 10000)
  // Each player answers on their own phone, after the battle and before their result card.
  await waitFor(a, 'feedback-form', 20000)
  check('phone: feedback before the result card', (await a.$(sel('phone-results'))) === null)
  await feedbackLayout(a, 'phone feedback 390×844', { fits: true })
  await noNervCentre(a, 'phone feedback')
  await a.screenshot({ path: path.join(OUT, '22a-phone-feedback.png') })
  // The connection drops while answering: the answer stays on the phone and the result card still shows.
  await a.setOfflineMode(true)
  await answerFeedback(a, { chips: [solutions[3].id] })
  check('offline: result card still shown', await has(a, 'phone-results', 12000))
  const queued = await a.evaluate(() => JSON.parse(localStorage.getItem('wr.feedback.outbox.v1') ?? '[]').length as number)
  check('offline: the answer is kept on the phone', queued === 1, String(queued))
  check('offline: not on the server yet', (await feedbackRowsFor('Alya Hassan')) === 0)
  await a.setOfflineMode(false)
  const synced = await a
    .waitForFunction(() => !localStorage.getItem('wr.feedback.outbox.v1'), { timeout: 40000, polling: 500 })
    .then(() => true)
    .catch(() => false)
  check('offline: sent by itself when back online', synced)
  await sleep(1500)
  check('offline: stored exactly once (no duplicates)', (await feedbackRowsFor('Alya Hassan')) === 1)
  check('phone: winner sees "You won the battle!"', /You won/.test(await text(a, sel('phone-results'))))
  await a.screenshot({ path: path.join(OUT, '22-phone-results.png') })
  await layoutCheck(a, 'phone results', { allowVertical: true })
  await click(a, 'continue')
  check('phone: thank-you after the result card', await has(a, 'phone-done', 5000))

  // Badrul opens the game again on his own phone (a 360 px Android screen): his own questions.
  const b2 = await bContext.newPage()
  await b2.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  b2.on('pageerror', (e) => check('no page errors (phone 360)', false, String(e)))
  await b2.goto(`${BASE}/#/join`, { waitUntil: 'networkidle2' })
  await waitFor(b2, 'feedback-form', 25000)
  check('team: the second player gets their own form on their own phone', (await b2.$$eval('[data-testid="feedback-form"] [aria-checked="true"]', (els) => els.length)) === 0)
  await feedbackLayout(b2, 'phone feedback 360×640 (Android Chrome size)', { fits: true })
  await b2.screenshot({ path: path.join(OUT, '22b-phone-feedback-360.png') })
  await b2.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')
  await b2.setViewport({ width: 375, height: 667, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await sleep(300)
  await feedbackLayout(b2, 'phone feedback 375×667 (iPhone SE size)', { fits: true })
  await b2.setViewport({ width: 360, height: 640, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await tap(b2, 'q1-yes')
  await tap(b2, 'q2-yes')
  await sleep(450)
  await feedbackLayout(b2, 'phone feedback 360×640 with the chips open')
  await b2.screenshot({ path: path.join(OUT, '22c-phone-feedback-chips-360.png') })
  await tap(b2, `chip-${solutions[0].id}`)
  await tap(b2, 'q3-star-5')
  await tap(b2, 'feedback-submit')
  await waitFor(b2, 'phone-results', 15000)
  check('team: second player sees their own result card', /You came 2nd/.test(await text(b2, sel('phone-results'))), (await text(b2, sel('phone-results'))).slice(0, 60))
  check('team: one answer each', (await feedbackRowsFor('Alya Hassan')) === 1 && (await feedbackRowsFor('Badrul Amin')) === 1)
  await b2.close()
  const boards = await api<{ wins_today: { name: string; wins: number }[] }>('/api/boards')
  check('boards: Multiplayer wins board', boards.wins_today[0]?.name === 'Alya Hassan' && boards.wins_today[0]?.wins === 1)
  await click(host, 'to-board')
  await waitFor(host, 'board-wins')
  await shot(host, '23-wins-board')
  await sleep(500)
  check('display: fastest of the day + total players', /\d+\.\d\d s/.test(await text(display, sel('display-fastest'))) && Number(await text(display, `${sel('display-players')} .font-display`)) >= 3)
  const displayBoard = await text(display, sel('display-board'))
  check('display: "Project / OPU" column', /Project \/ OPU/i.test(displayBoard) && !/Department/i.test(displayBoard))
  check('display: board shows project names and OPUs', /Kasawari CCS/.test(displayBoard) && /Upstream/.test(displayBoard) && /Gas & Maritime/.test(displayBoard) && /Jerun/.test(displayBoard), displayBoard.replace(/\s+/g, ' ').slice(0, 300))
  const fastest = await api<{ stats: { fastest_today: { affiliation: string } | null } }>('/api/boards')
  check('display: fastest of the day shows their project / OPU', !!fastest.stats.fastest_today && (await text(display, sel('display-fastest-affiliation'))) === fastest.stats.fastest_today.affiliation, await text(display, sel('display-fastest-affiliation')))
  await noNervCentre(display, 'TV display')
  await shot(display, '24-display')
  for (const p of [host, a, c, display]) await p.close()
  await setSettings({ timer_seconds: 30, howto_seconds: 10 })
}

async function h2hFlow(browser: Browser) {
  section('Phase 3 – Head-to-Head split screen')
  await setSettings({ timer_seconds: 25 })
  const page = await kiosk(browser)
  await click(page, 'mode-h2h')
  await waitFor(page, 'h2h-register')
  check('h2h: two registration forms, nothing pre-selected', (await page.$$eval('[role="radio"]', (els) => els.map((e) => e.getAttribute('aria-checked')).join())) === 'false,false,false,false')
  check('h2h: Start disabled until both are valid', (await ariaDisabled(page, 'start')) === 'true')
  await register(page, { name: 'Lina Left', project: 'kasawari  ccs' }, 'p1-')
  check('h2h: still disabled with one player done', (await ariaDisabled(page, 'start')) === 'true')
  await register(page, { name: 'Rizal Right', opu: 'PE&T - PDSB' }, 'p2-')
  check('h2h: Start enabled when both are valid', (await ariaDisabled(page, 'start')) === 'false')
  await noNervCentre(page, 'h2h registration')
  await shot(page, '25-h2h-register')
  await layoutCheck(page, 'h2h register')
  check('h2h register: both cards and Start fully on screen', await page.evaluate(() => ['p1-card', 'p2-card', 'start'].every((id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().bottom <= innerHeight)))
  await click(page, 'start')
  await click(page, 'ready')
  await waitGo(page)
  await shot(page, '26-h2h-race')
  await layoutCheck(page, 'h2h race')
  // Both play at once: left builds everything, right builds three.
  let left = 0
  let right = 0
  for (let i = 0; i < 6; i++) {
    if (await solveCurrent(page, 'board-left')) left++
    if (i < 3 && (await solveCurrent(page, 'board-right'))) right++
  }
  check('h2h: both halves playable at the same time', left === 6 && right === 3, `${left}/${right}`)
  await waitFor(page, 'h2h-reveal', 40000)
  check('h2h: winner announced', /Lina Left wins/.test(await text(page, sel('h2h-reveal'))))
  await shot(page, '27-h2h-reveal')
  // Each player answers for themselves, one after the other, before the results.
  await waitFor(page, 'feedback-form', 15000)
  check('h2h: Player 1 answers first', /Player 1 of 2 · Lina Left/.test(await text(page, sel('feedback-who'))), await text(page, sel('feedback-who')))
  await answerFeedback(page, { stars: 5, chips: [solutions[5].id] })
  const second = await page
    .waitForFunction(() => /Player 2 of 2 · Rizal Right/.test(document.querySelector('[data-testid="feedback-who"]')?.textContent ?? ''), { timeout: 10000 })
    .then(() => true)
    .catch(() => false)
  check('h2h: then Player 2 gets their own form', second)
  check('h2h: Player 2 starts with nothing selected', (await page.$$eval('[data-testid="feedback-form"] [aria-checked="true"]', (els) => els.length)) === 0)
  await shot(page, '27b-h2h-feedback')
  await answerFeedback(page, { q1: true, q2: false, stars: 3 })
  await waitFor(page, 'results', 15000)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="title"]').length === 2, { timeout: 10000 })
  check('h2h: one answer per player', (await feedbackRowsFor('Lina Left')) === 1 && (await feedbackRowsFor('Rizal Right')) === 1)
  await shot(page, '28-h2h-results')
  await click(page, 'continue')
  await waitFor(page, 'leaderboard')
  await sleep(400)
  const h2hBoard = await text(page, sel('board-today'))
  check('h2h leaderboard: Business player with OPU, Project player grouped with the same project', /Rizal Right[\s\S]*?PE&T - PDSB/.test(h2hBoard) && /Lina Left[\s\S]*?Kasawari CCS/.test(h2hBoard), h2hBoard.replace(/\s+/g, ' ').slice(0, 300))
  await click(page, 'done')
  await page.close()
  await setSettings({ timer_seconds: 30 })
}

async function adminPhase3(browser: Browser) {
  section('Phase 3 – dashboard, project names, OPUs, exports, rehearsal data')
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 1000 })
  await page.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle2' })
  await typeInto(page, sel('admin-pin'), NEW_PIN)
  await click(page, 'admin-login-submit')
  await waitFor(page, 'dashboard')
  await sleep(800)
  const players = Number((await text(page, `${sel('kpi-players')} .text-2xl`)).replace(/\D/g, ''))
  check('dashboard: players today', players >= 6, String(players))
  check('dashboard: understanding (feedback Q3) average', /\d\.\d \/ 5/.test(await text(page, sel('kpi-understanding'))))
  for (const c of ['chart-timeline', 'chart-solved', 'chart-modes', 'chart-solutions', 'chart-affiliation', 'chart-opus', 'chart-projects', 'chart-interest']) {
    check(`dashboard: ${c.replace('chart-', '')} chart`, await has(page, c, 3000))
  }
  const split = await text(page, sel('affiliation-split'))
  check('dashboard: Project vs Business split', /Project\s+\d+\s+·\s+\d+%/.test(split) && /Business\s+\d+\s+·\s+\d+%/.test(split), split.replace(/\s+/g, ' '))
  const opuChart = await text(page, sel('opu-bars'))
  check(
    'dashboard: participants by OPU',
    ['Upstream - PMA', 'Gas & Maritime - MLNG', 'PE&T - PDSB'].every((o) => opuChart.includes(o)) && /Upstream - PMA[\s\S]*?1/.test(opuChart) && (await has(page, 'opu-zero-note', 1000)),
    opuChart.replace(/\s+/g, ' ').slice(0, 200),
  )
  const projectChart = await text(page, sel('project-bars'))
  check('dashboard: participants by project name, grouped case-insensitively', /Kasawari CCS\s+2/.test(projectChart) && !/kasawari {2}ccs/.test(projectChart), projectChart.replace(/\s+/g, ' ').slice(0, 200))
  await noNervCentre(page, 'admin dashboard')
  await shot(page, '29-admin-dashboard')
  await page.screenshot({ path: path.join(OUT, '29b-admin-dashboard-full.png'), fullPage: true })

  // Exports (fetched with the admin token from the page)
  const exp = await page.evaluate(async () => {
    const token = sessionStorage.getItem('wr.admin.token')
    const x = await fetch('/api/admin/export.xlsx?day=today&mode=all', { headers: { authorization: `Bearer ${token}` } })
    const buf = new Uint8Array(await x.arrayBuffer())
    const c = await fetch('/api/admin/export.csv?table=games&day=all&mode=all', { headers: { authorization: `Bearer ${token}` } })
    const p = await fetch('/api/admin/export.csv?table=participants&day=all&mode=all', { headers: { authorization: `Bearer ${token}` } })
    return { xType: x.headers.get('content-type'), zip: String.fromCharCode(buf[0], buf[1]), csv: await c.text(), participants: await p.text() }
  })
  check('export: Excel report (.xlsx)', exp.zip === 'PK' && /spreadsheetml/.test(exp.xType ?? ''))
  check('export: games CSV has Full name, From, Project name, Project group, OPU', exp.csv.includes('"Full name","From","Project name (as typed)","Project group","OPU"'))
  check('export: games CSV rows carry the new data', exp.csv.includes('"Firdaus Zahin","Project","Kasawari CCS","Kasawari CCS",""') && exp.csv.includes('"Aina Rahman","Business","","","Upstream - PMA"'))
  check('export: participants CSV has the new columns', exp.participants.includes('"Full name","From","Project name","OPU"') && exp.participants.includes('"Badrul Amin","Business","","Gas & Maritime - MLNG"'))
  check('export: no "Department" column left', !/Department/i.test(exp.csv) && !/Department/i.test(exp.participants))

  // Project names: "Kasawari CCS" / "kasawari  ccs" grouped automatically; merge "Jerun" into it and undo.
  await click(page, 'admin-tab-projects')
  await waitFor(page, 'projects-tab')
  await sleep(500)
  const groupRow = await page.$$eval('[data-testid="project-row"]', (rows) => rows.map((r) => (r as HTMLElement).innerText).find((t) => /Kasawari CCS/.test(t)) ?? '')
  check('project names: spellings grouped case-insensitively', /Kasawari CCS ×1/.test(groupRow) && /kasawari ccs ×1/.test(groupRow) && /\t2\t/.test(groupRow), groupRow.replace(/\s+/g, ' '))
  await page.evaluate(() => {
    for (const row of document.querySelectorAll('[data-testid="project-row"]')) {
      const label = (row.querySelectorAll('td')[1] as HTMLElement).innerText.trim()
      if (label === 'Jerun' || label === 'Kasawari CCS') (row.querySelector('input[type="checkbox"]') as HTMLInputElement).click()
    }
  })
  await waitFor(page, 'merge-panel')
  await page.select(sel('merge-target'), 'kasawari ccs')
  await click(page, 'merge')
  await sleep(800)
  let boards = await api<{ today: { name: string; affiliation: string }[] }>('/api/boards')
  check('project names: Admin merge applies to the boards', boards.today.find((r) => r.name === 'Alya Hassan')?.affiliation === 'Kasawari CCS')
  await shot(page, '30-admin-project-names')
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('[data-testid="projects-tab"] button')].find((x) => /unmerge “jerun”/.test((x as HTMLElement).innerText))
    ;(b as HTMLButtonElement | undefined)?.click()
  })
  await sleep(800)
  boards = await api<{ today: { name: string; affiliation: string }[] }>('/api/boards')
  check('project names: a merge can be undone', boards.today.find((r) => r.name === 'Alya Hassan')?.affiliation === 'Jerun')
  await noNervCentre(page, 'admin project names')

  // The OPU list lives in Settings, editable by Admin.
  await click(page, 'admin-tab-settings')
  await waitFor(page, 'settings-tab')
  const opuText = await page.$eval(sel('set-opus'), (e) => (e as HTMLTextAreaElement).value)
  check('settings: OPU list editable in Admin (in order)', opuText.split('\n').join('|') === OPUS.join('|'), opuText.split('\n').join(' | '))
  await noNervCentre(page, 'admin settings')

  // Rehearsal data
  await setSettings({ rehearsal_mode: true })
  const k = await kiosk(browser)
  check('rehearsal: badge on the kiosk', await has(k, 'rehearsal-badge', 5000))
  await startSolo(k, { name: 'Rehearsal Robot', project: 'Booth Team' })
  await waitGo(k)
  for (let i = 0; i < 6; i++) await solveCurrent(k, 'solo-race')
  await answerFeedback(k, { q1: false, q2: false, stars: 1 })
  await waitFor(k, 'results', 15000)
  await k.close()
  await setSettings({ rehearsal_mode: false })
  const allTime = await api<{ all_time: { name: string }[] }>('/api/boards')
  check('rehearsal: game never reaches the boards', !allTime.all_time.some((r) => r.name === 'Rehearsal Robot'))
  const fbRehearsal = await api<{ responses: number; rehearsal_responses: number }>('/api/admin/feedback', { token: adminToken })
  check('rehearsal: feedback answer left out of the Feedback numbers', fbRehearsal.rehearsal_responses === 1 && (await feedbackRowsFor('Rehearsal Robot')) === 0, JSON.stringify(fbRehearsal))
  await click(page, 'admin-tab-data')
  await waitFor(page, 'data-tab')
  await typeInto(page, sel('test-pin'), NEW_PIN)
  await click(page, 'delete-test')
  await click(page, 'delete-test')
  await sleep(1200)
  check('data: rehearsal data deleted (with a backup first)', /Deleted 1 rehearsal/.test(await text(page, sel('data-tab'))), await text(page, '[role="status"]'))
  // Admin → Feedback: numbers on screen = numbers in the database (via the API).
  await click(page, 'admin-tab-feedback')
  await waitFor(page, 'feedback-tab')
  await sleep(800)
  type FbDash = {
    responses: number
    completed_games: number
    rehearsal_responses: number
    q1: { yes: number; no: number }
    q2: { yes: number; no: number }
    q3: { average: number | null }
    solutions: { name: string; players: number }[]
    by_opu: { label: string; responses: number }[]
    by_project: { label: string; responses: number }[]
  }
  const fb = await api<FbDash>('/api/admin/feedback', { token: adminToken })
  const tile = async (id: string) => (await text(page, `${sel(id)} .text-2xl`)).trim()
  check('feedback section: 7 answers (Firdaus, Aina, Hard Mode Hero, Alya, Badrul, Lina, Rizal)', fb.responses === 7 && (await tile('fb-kpi-responses')) === '7', JSON.stringify({ api: fb.responses, shown: await tile('fb-kpi-responses') }))
  check('feedback section: rehearsal answers deleted with the rehearsal data', fb.rehearsal_responses === 0)
  const pct = (a: number, b: number) => `${Math.round((a / b) * 100)}%`
  check('feedback section: response rate = answers ÷ completed games', (await tile('fb-kpi-rate')) === pct(fb.responses, fb.completed_games), `${await tile('fb-kpi-rate')} vs ${fb.responses}/${fb.completed_games}`)
  check('feedback section: Q1 / Q2 % Yes', (await tile('fb-kpi-q1')) === pct(fb.q1.yes, fb.responses) && (await tile('fb-kpi-q2')) === pct(fb.q2.yes, fb.responses))
  check('feedback section: Q3 average stars', (await tile('fb-kpi-q3')) === `${fb.q3.average!.toFixed(1)} / 5`, await tile('fb-kpi-q3'))
  for (const c of ['donut-q1', 'donut-q2', 'chart-q3', 'chart-solution-interest', 'breakdown-opu']) check(`feedback section: ${c}`, await has(page, c, 3000))
  check('feedback section: Q1 donut shows % Yes in the middle', (await text(page, sel('donut-q1'))).includes(pct(fb.q1.yes, fb.responses)))
  const bars = await text(page, sel('solution-interest-bars'))
  check('feedback section: solution interest, highest first', bars.indexOf(fb.solutions[0].name) <= bars.indexOf(fb.solutions[fb.solutions.length - 1].name) && fb.solutions.every((s, i) => i === 0 || fb.solutions[i - 1].players >= s.players))
  check('feedback section: breakdown by OPU', /Upstream - PMA/.test(await text(page, sel('breakdown-opu'))))
  await click(page, 'fb-breakdown-project')
  check('feedback section: breakdown by project name (grouped)', /Kasawari CCS/.test(await text(page, sel('breakdown-project'))))
  await page.select(sel('fb-mode'), 'team')
  await sleep(900)
  const teamApi = await api<FbDash>('/api/admin/feedback?mode=team', { token: adminToken })
  check('feedback section: game mode filter (Team = Alya, Badrul, Lina, Rizal)', teamApi.responses === 4 && (await tile('fb-kpi-responses')) === '4')
  await page.select(sel('fb-mode'), 'all')
  await page.select(sel('fb-opu'), 'Upstream - PMA')
  await sleep(900)
  const opuAff = await page.$eval(sel('fb-affiliation'), (e) => (e as HTMLSelectElement).value)
  check('feedback section: OPU filter (Aina)', (await tile('fb-kpi-responses')) === '1' && opuAff === 'business', `${await tile('fb-kpi-responses')} · ${opuAff}`)
  await page.select(sel('fb-opu'), '')
  await page.select(sel('fb-affiliation'), 'all')
  await sleep(900)
  check('feedback section: back to every answer after clearing the filters', (await tile('fb-kpi-responses')) === String(fb.responses), await tile('fb-kpi-responses'))
  await noNervCentre(page, 'admin feedback')
  await page.screenshot({ path: path.join(OUT, '31-admin-feedback.png'), fullPage: true })
  const fbExp = await page.evaluate(async () => {
    const token = sessionStorage.getItem('wr.admin.token')
    const c = await fetch('/api/admin/feedback/export.csv?mode=team', { headers: { authorization: `Bearer ${token}` } })
    const x = await fetch('/api/admin/feedback/export.xlsx', { headers: { authorization: `Bearer ${token}` } })
    const buf = new Uint8Array(await x.arrayBuffer())
    return { csv: await c.text(), zip: String.fromCharCode(buf[0], buf[1]), xType: x.headers.get('content-type') }
  })
  check('feedback export: CSV (filtered)', fbExp.csv.trim().split('\r\n').length === 1 + teamApi.responses && fbExp.csv.includes('"Q1 Relevant","Q2 Would explore","Q2 Interested solutions","Q3 Understanding (1-5)"'))
  check('feedback export: Excel', fbExp.zip === 'PK' && /spreadsheetml/.test(fbExp.xType ?? ''))
  await click(page, 'admin-tab-audit')
  await waitFor(page, 'audit-tab')
  await sleep(400)
  const audit = await text(page, sel('audit-tab'))
  check('audit: important actions logged', ['pin changed', 'settings saved', 'run removed', 'test data deleted', 'export', 'projects merged', 'project unmerged'].every((a) => audit.includes(a)))
  await page.close()
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(path.join(ROOT, 'dist/client/index.html'))) throw new Error('Run "npm run build" first.')
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const tmp = mkdtempSync(path.join(tmpdir(), 'wordrush-e2e-'))
  const server = await startServer(path.join(tmp, 'data'))
  const browser = await puppeteer.launch({ executablePath: findBrowser(), headless: true, args: ['--no-first-run', '--autoplay-policy=no-user-gesture-required'] })
  const started = Date.now()
  try {
    await adminFirstLogin(browser)
    await soloFlow(browser)
    await registrationPaths(browser)
    await refreshAndTimeUp(browser)
    await adminBasics(browser)
    await battleFlow(browser)
    await h2hFlow(browser)
    await adminPhase3(browser)
  } catch (err) {
    check('scenario completed without errors', false, (err as Error).stack?.split('\n').slice(0, 3).join(' | ') ?? String(err))
    const pages = await browser.pages()
    for (const [i, p] of pages.entries()) await p.screenshot({ path: path.join(OUT, `FAIL-${i}.png`) }).catch(() => {})
  } finally {
    await browser.close()
    server.kill()
    await sleep(500)
    rmSync(tmp, { recursive: true, force: true })
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - started) / 1000)} s. Screenshots: ${OUT}`)
  if (failed.length) {
    console.log('Failed:')
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`)
    process.exitCode = 1
  }
}

void main()
