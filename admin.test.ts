import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { DashboardData } from '@shared/dashboard'
import { uuid } from '@shared/random'
import { COUNTDOWN_MS, DEFAULT_OPUS } from '@shared/seed'
import type { Boards, Puzzle, RaceState, Settings, Solution } from '@shared/types'
import { adminToken, ask, bizPlayer, http, player, solveOne, startServer, type TestServer } from './helpers'

type Started = { ok: boolean; race: RaceState; run_id: string; token: string }

/** Plays a solo game solving `n` solutions, then lets the clock run out. */
async function playSolo(srv: TestServer, who: ReturnType<typeof player> | ReturnType<typeof bizPlayer>, n: number) {
  const s = await srv.connect()
  const st = await ask<Started>(s, 'solo:start', { player: who, kiosk_id: 'admin-test' })
  assert.ok(st.ok, JSON.stringify(st))
  const seat = { race_id: st.race.id, run_id: st.run_id, token: st.token }
  srv.advance(COUNTDOWN_MS + 300)
  let p = st.race.runs[0].progress
  for (let i = 0; i < n; i++) p = (await solveOne(s, st.race, seat, p)).progress
  if (n < 6) {
    srv.advance(40_000)
    await ask(s, 'run:tap', { ...seat, puzzle: p.queue[0], tile: st.race.puzzles[p.queue[0]].tiles[0].id })
  }
  await srv.services.engine.flush()
  s.disconnect()
  return seat
}

describe('Admin', () => {
  let srv: TestServer
  let token: string
  before(async () => {
    srv = await startServer()
  })
  after(() => srv.close())

  it('default PIN must be changed first; weak PINs are refused; 5 wrong PINs lock Admin', async () => {
    const first = await http<{ token: string; must_change_pin: boolean }>(srv.url, '/api/admin/login', { json: { pin: '1234' } })
    assert.equal(first.status, 200)
    assert.equal(first.body.must_change_pin, true)
    const blocked = await http(srv.url, '/api/admin/settings', { token: first.body.token })
    assert.equal(blocked.status, 403)
    const weak = await http<{ message: string }>(srv.url, '/api/admin/pin', { json: { current: '1234', next: '123456' }, token: first.body.token })
    assert.equal(weak.status, 400)
    const same = await http(srv.url, '/api/admin/pin', { json: { current: '1234', next: '1234' }, token: first.body.token })
    assert.equal(same.status, 400)
    token = await adminToken(srv.url)
    assert.equal((await http(srv.url, '/api/admin/settings', { token })).status, 200)
    const old = await http(srv.url, '/api/admin/login', { json: { pin: '1234' } })
    assert.equal(old.status, 401, 'the default PIN never works again')
    for (let i = 0; i < 4; i++) await http(srv.url, '/api/admin/login', { json: { pin: '999999' } })
    // 1 failed already above + 4 = 5 → locked
    const locked = await http(srv.url, '/api/admin/login', { json: { pin: '482915' } })
    assert.equal(locked.status, 423)
    // Unlock for the remaining tests.
    const admin = await srv.store.getAdmin()
    await srv.store.setAdminFailures(admin!.id, 0, null)
    token = (await http<{ token: string }>(srv.url, '/api/admin/login', { json: { pin: '482915' } })).body.token
    assert.equal((await http(srv.url, '/api/admin/settings')).status, 401)
  })

  it('settings: timer, penalties, Hard Mode – validated and applied to the next game', async () => {
    const bad = await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { timer_seconds: 5 }, token })
    assert.equal(bad.status, 400)
    const badDecoys = await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { decoys_min: 4, decoys_max: 2 }, token })
    assert.equal(badDecoys.status, 400)
    const ok = await http<Settings>(srv.url, '/api/admin/settings', { method: 'PUT', json: { timer_seconds: 45, wrong_penalty_ms: 1500, hard_mode: true }, token })
    assert.equal(ok.status, 200)
    assert.equal(ok.body.timer_seconds, 45)
    const s = await srv.connect()
    const st = await ask<Started>(s, 'solo:start', { player: player('Hard Mode Tester', 'Hard Mode Lab'), kiosk_id: 'k' })
    assert.equal(st.race.rules.limit_ms, 45_000)
    assert.equal(st.race.rules.wrong_penalty_ms, 1500)
    assert.ok(st.race.puzzles.some((p: Puzzle) => p.tiles.some((t) => t.kind === 'letter')))
    await srv.services.engine.adminStop(st.race.id)
    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { timer_seconds: 30, wrong_penalty_ms: 1000, hard_mode: false }, token })
    s.disconnect()
  })

  it('settings: the OPU list is editable (order kept) and used by registration', async () => {
    const cur = (await http<Settings>(srv.url, '/api/admin/settings', { token })).body
    assert.deepEqual(cur.opus, DEFAULT_OPUS)
    const pub = (await http<{ settings: Settings }>(srv.url, '/api/config')).body
    assert.deepEqual(pub.settings.opus, DEFAULT_OPUS, 'devices get the list with the public config')
    assert.equal((await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { opus: [] }, token })).status, 400)
    assert.equal((await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { opus: ['Finance', 'finance'] }, token })).status, 400, 'no repeats (any case)')
    assert.equal((await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { opus: ['X'] }, token })).status, 400, 'at least 2 characters')
    const edited = await http<Settings>(srv.url, '/api/admin/settings', { method: 'PUT', json: { opus: [...DEFAULT_OPUS, 'PETRONAS Dagangan'] }, token })
    assert.equal(edited.status, 200)
    assert.equal(edited.body.opus.at(-1), 'PETRONAS Dagangan')
    const ok = await http(srv.url, '/api/players/validate', { json: bizPlayer('New OPU Person', 'petronas dagangan') })
    assert.equal(ok.status, 200)
    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { opus: DEFAULT_OPUS }, token })
    const gone = await http<{ field: string }>(srv.url, '/api/players/validate', { json: bizPlayer('New OPU Person', 'PETRONAS Dagangan') })
    assert.equal(gone.body.field, 'opu', 'removed OPUs can no longer be chosen')
  })

  it('solutions: names, clues and decoys are editable (decoys never repeat an answer word)', async () => {
    const list = (await http<Solution[]>(srv.url, '/api/admin/solutions', { token })).body
    assert.equal(list.length, 6)
    const edited = list.map((x) => (x.id === 'pcc' ? { ...x, clue: 'Central view of the whole project', decoys: ['Command', 'Room', 'Hub'] } : x))
    const saved = await http<Solution[]>(srv.url, '/api/admin/solutions', { method: 'PUT', json: edited, token })
    assert.equal(saved.status, 200)
    const pcc = saved.body.find((x) => x.id === 'pcc')!
    assert.equal(pcc.clue, 'Central view of the whole project')
    assert.deepEqual(pcc.decoys, ['Room', 'Hub'])
    const dup = await http(srv.url, '/api/admin/solutions', { method: 'PUT', json: list.map((x) => ({ ...x, name: 'PTQ Online' })), token })
    assert.equal(dup.status, 400)
    const preview = await http<Puzzle[]>(srv.url, '/api/admin/preview?hard=1', { token })
    assert.equal(preview.body.length, 6)
  })

  it('remove / restore entries, reset the daily board, merge project names', async () => {
    const a = await playSolo(srv, player('Zara', 'Kasawari'), 6)
    await playSolo(srv, player('Yusof', 'Kasawari CCS'), 4)
    await playSolo(srv, player('Xin', 'KASAWARI '), 3)
    await playSolo(srv, bizPlayer('Wan', 'Upstream - PMA'), 2)
    let boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today[0].name, 'Zara')

    assert.equal((await http(srv.url, `/api/admin/runs/${a.run_id}/remove`, { json: { reason: 'Staff test' }, token })).status, 200)
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.ok(!boards.today.some((r) => r.name === 'Zara'), 'removed entries leave the boards')
    assert.equal((await http(srv.url, `/api/admin/runs/${a.run_id}/restore`, { json: {}, token })).status, 200)
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today[0].name, 'Zara')

    // Project names: "Kasawari" and "KASAWARI " group automatically; "Kasawari CCS" is merged by Admin. OPUs are never grouped.
    const projects = (await http<{ groups: { key: string; label: string; players: number }[] }>(srv.url, '/api/admin/projects', { token })).body
    const k = projects.groups.find((g) => g.key === 'kasawari')!
    assert.equal(k.players, 2)
    assert.equal(k.label, 'KASAWARI', 'one player each – the tie goes to the spelling with more capitals')
    assert.ok(!projects.groups.some((g) => g.key === 'upstream'), 'OPUs are not project names')
    const merge = await http(srv.url, '/api/admin/projects/merge', { json: { keys: ['kasawari', 'kasawari ccs'], target: 'kasawari', label: 'Kasawari CCS' }, token })
    assert.equal(merge.status, 200)
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today.find((r) => r.name === 'Yusof')!.affiliation, 'Kasawari CCS')
    assert.equal(boards.today.find((r) => r.name === 'Xin')!.affiliation, 'Kasawari CCS')
    assert.equal(boards.today.find((r) => r.name === 'Wan')!.affiliation, 'Upstream - PMA')
    const runs = (await http<{ name: string; affiliation: string; affiliation_group: string }[]>(srv.url, '/api/admin/runs?day=today', { token })).body
    const yusof = runs.find((r) => r.name === 'Yusof')!
    assert.equal(yusof.affiliation, 'Kasawari CCS')
    assert.equal(yusof.affiliation_group, 'Kasawari CCS')
    const xin = runs.find((r) => r.name === 'Xin')!
    assert.equal(xin.affiliation, 'KASAWARI', 'as typed (trimmed)')
    assert.equal(xin.affiliation_group, 'Kasawari CCS')
    const unmerge = await http(srv.url, '/api/admin/projects/unmerge', { json: { key: 'kasawari ccs' }, token })
    assert.equal(unmerge.status, 200)
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today.find((r) => r.name === 'Yusof')!.affiliation, 'Kasawari CCS', 'its own group again')
    assert.equal(boards.today.find((r) => r.name === 'Zara')!.affiliation, 'Kasawari CCS', 'label override stays on the group')
    await http(srv.url, '/api/admin/projects/label', { json: { key: 'kasawari', label: null }, token })
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today.find((r) => r.name === 'Zara')!.affiliation, 'KASAWARI', 'back to the automatic label')

    const reset = await http(srv.url, '/api/admin/boards/reset-daily', { json: {}, token })
    assert.equal(reset.status, 200)
    boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.equal(boards.today.length, 0, 'today starts again')
    assert.ok(boards.all_time.length >= 3, 'all-time is kept')
  })

  it('feedback, rehearsal mode, dashboard, exports and test-data removal', async () => {
    const seat = await playSolo(srv, bizPlayer('Feedback Fan', 'Gas & Maritime - MLNG'), 5)
    const answers = { q1_relevant: true, q2_would_explore: true, q2_interested_solutions: ['sid'], q3_understanding_rating: 5 }
    const fb = await http(srv.url, '/api/feedback', { json: { ...seat, ...answers, feedback_id: uuid() } })
    assert.equal(fb.status, 200)
    const again = await http(srv.url, '/api/feedback', { json: { ...seat, ...answers, feedback_id: uuid(), q3_understanding_rating: 4 } })
    assert.equal(again.status, 409, 'once per player per day')

    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { rehearsal_mode: true }, token })
    await playSolo(srv, player('Rehearsal Person', 'Jerun'), 6)
    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { rehearsal_mode: false }, token })
    const boards = (await http<Boards>(srv.url, '/api/boards')).body
    assert.ok(!boards.all_time.some((r) => r.name === 'Rehearsal Person'), 'rehearsal games never reach the boards')

    const dash = (await http<DashboardData>(srv.url, '/api/admin/dashboard?day=today', { token })).body
    assert.ok(dash.kpis.games >= 4)
    assert.equal(dash.kpis.rehearsal_games, 1)
    assert.equal(dash.kpis.feedback, 1)
    assert.equal(dash.kpis.avg_understanding, 5)
    assert.equal(dash.interest.find((i) => i.id === 'sid')!.players, 1)
    assert.equal(dash.solutions.length, 6)
    // Project vs Business split, players by OPU (every listed OPU, in list order), players by project name.
    const projectPeople = dash.projects.reduce((n, p) => n + p.players, 0)
    assert.equal(dash.affiliation_split.project.players, projectPeople, 'split and per-project counts agree (rehearsal excluded)')
    assert.ok(projectPeople >= 3, 'Zara, Yusof, Xin')
    assert.equal(dash.affiliation_split.business.players, 2, 'Wan, Feedback Fan')
    assert.deepEqual(dash.opus.slice(0, DEFAULT_OPUS.length).map((o) => o.name), DEFAULT_OPUS)
    assert.equal(dash.opus.find((o) => o.name === 'Upstream - PMA')!.players, 1)
    assert.equal(dash.opus.find((o) => o.name === 'Gas & Maritime - MLNG')!.players, 1)
    assert.equal(dash.opus.find((o) => o.name === 'Others')!.players, 0)
    assert.equal(dash.projects.find((p) => p.label === 'KASAWARI')?.players, 2)
    assert.equal(dash.projects.find((p) => p.label === 'Kasawari CCS')?.players, 1)
    assert.ok(!dash.projects.some((p) => p.label === 'Jerun'), 'rehearsal players are not counted')

    const csv = await http<ArrayBuffer>(srv.url, '/api/admin/export.csv?table=games', { token })
    assert.equal(csv.status, 200)
    const text = Buffer.from(csv.body).toString('utf8')
    assert.ok(text.startsWith('\uFEFF"Ended (KL)","Mode","Full name","From","Project name (as typed)","Project group","OPU"'), text.slice(0, 160))
    assert.ok(text.includes('"Feedback Fan","Business","","","Gas & Maritime - MLNG"'), 'business rows carry the OPU')
    assert.ok(text.includes('"Yusof","Project","Kasawari CCS","Kasawari CCS",""'), 'project rows carry the project name')
    for (const table of ['participants', 'feedback', 'projects', 'opus']) {
      const t = await http<ArrayBuffer>(srv.url, `/api/admin/export.csv?table=${table}`, { token })
      assert.equal(t.status, 200, table)
      const body = Buffer.from(t.body).toString('utf8')
      if (table === 'participants') assert.ok(body.includes('"Full name","From","Project name","OPU"'), table)
      if (table === 'feedback') assert.ok(body.includes('"Full name","From","Project name","Project group","OPU"') && body.includes('"Feedback Fan","Business"'), table)
      if (table === 'opus') assert.ok(body.includes('"Upstream - PMA","1"'), body.slice(0, 200))
    }
    const xlsx = await http<ArrayBuffer>(srv.url, '/api/admin/export.xlsx', { token })
    assert.equal(xlsx.status, 200)
    assert.equal(Buffer.from(xlsx.body).subarray(0, 2).toString(), 'PK')

    const wrongPin = await http(srv.url, '/api/admin/test-data/delete', { json: { pin: '000000' }, token })
    assert.equal(wrongPin.status, 400)
    const del = await http<{ runs: number }>(srv.url, '/api/admin/test-data/delete', { json: { pin: '482915' }, token })
    assert.equal(del.status, 200)
    assert.equal(del.body.runs, 1, 'only the rehearsal game')

    const audit = (await http<{ action: string }[]>(srv.url, '/api/admin/audit', { token })).body
    for (const action of ['settings_saved', 'run_removed', 'run_restored', 'projects_merged', 'project_unmerged', 'project_renamed', 'daily_board_reset', 'export', 'test_data_deleted']) {
      assert.ok(audit.some((a) => a.action === action), `audit has ${action}`)
    }
  })
})
