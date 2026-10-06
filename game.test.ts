import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { COUNTDOWN_MS } from '@shared/seed'
import type { Boards, RaceState, RunProgress, RunResult } from '@shared/types'
import { buildApp } from '../../server/app'
import { ask, bizPlayer, http, nextState, player, solveOne, startServer, wait, type Client, type Seat, type TestServer } from './helpers'

type Started = { ok: boolean; race: RaceState; run_id: string; token: string; error?: string; message?: string; field?: string }

describe('Solo Rush', () => {
  let srv: TestServer
  before(async () => {
    srv = await startServer()
  })
  after(() => srv.close())

  it('plays a full round: server times every tap, penalties count, result and board are right', async () => {
    const kiosk = await srv.connect()
    const start = await ask<Started>(kiosk, 'solo:start', { player: player('Firdaus Zahin', 'Kasawari CCS'), kiosk_id: 'k1' })
    assert.ok(start.ok, JSON.stringify(start))
    assert.equal(start.race.status, 'running')
    assert.equal(start.race.puzzles.length, 6)
    assert.ok(start.race.go_at! - Date.now() > COUNTDOWN_MS - 500, 'GO is after the 3-2-1')
    const seat: Seat = { race_id: start.race.id, run_id: start.run_id, token: start.token }

    // Taps before GO are refused.
    const early = await ask<{ ok: boolean; error: string }>(kiosk, 'run:tap', { ...seat, puzzle: 0, tile: 't0' })
    assert.equal(early.error, 'too_early')

    srv.advance(COUNTDOWN_MS + 2000) // GO + 2 s of play
    let progress: RunProgress = start.race.runs[0].progress
    // One wrong tile (+1 s) and one skip (+2 s).
    const puzzle = start.race.puzzles[progress.queue[0]]
    const wrong = puzzle.tiles.find((t) => t.text !== puzzle.answer[0].text)!
    const w = await ask<{ ok: boolean; outcome: string; progress: RunProgress }>(kiosk, 'run:tap', { ...seat, puzzle: progress.queue[0], tile: wrong.id })
    assert.equal(w.outcome, 'wrong')
    assert.equal(w.progress.penalty_ms, 1000)
    const sk = await ask<{ ok: boolean; outcome: string; progress: RunProgress }>(kiosk, 'run:skip', { ...seat, puzzle: w.progress.queue[0] })
    assert.equal(sk.outcome, 'skipped')
    progress = sk.progress
    for (let i = 0; i < 6; i++) {
      const res = await solveOne(kiosk, start.race, seat, progress)
      progress = res.progress
      srv.advance(1000)
    }
    assert.equal(progress.ended, 'finished')
    assert.equal(progress.penalty_ms, 3000)
    // ~2 s + 5 × 1 s real play + 3 s penalties (a few ms for the round trips).
    assert.ok(progress.finish_ms! >= 10_000 && progress.finish_ms! < 10_600, `finish ${progress.finish_ms}`)

    await srv.services.engine.flush()
    const result = await http<RunResult>(srv.url, `/api/runs/${seat.run_id}/result`, { headers: { 'x-run-token': seat.token } })
    assert.equal(result.status, 200)
    assert.equal(result.body.solved, 6)
    assert.equal(result.body.title, 'NC Master')
    assert.equal(result.body.rank_today, 1)
    assert.equal(result.body.recap.length, 6)
    assert.ok(result.body.recap.every((r) => r.solved && r.description))

    const noToken = await http(srv.url, `/api/runs/${seat.run_id}/result`)
    assert.equal(noToken.status, 404)

    const boards = await http<Boards>(srv.url, '/api/boards')
    assert.equal(boards.body.today[0].name, 'Firdaus Zahin')
    assert.equal(boards.body.today[0].affiliation_type, 'project')
    assert.equal(boards.body.today[0].affiliation, 'Kasawari CCS')
    assert.equal(boards.body.today[0].solved, 6)
    assert.equal(boards.body.stats.players_today, 1)
    assert.equal(boards.body.stats.fastest_today?.affiliation, 'Kasawari CCS')
  })

  it('refuses invalid registrations with the field to fix', async () => {
    const kiosk = await srv.connect()
    const bad = await ask<Started>(kiosk, 'solo:start', { player: player('12345'), kiosk_id: 'k1' })
    assert.equal(bad.ok, false)
    assert.equal(bad.field, 'full_name')
    assert.equal(bad.message, 'Please enter your full name.')
    const rude = await ask<Started>(kiosk, 'solo:start', { player: player('Aina', 'babi'), kiosk_id: 'k1' })
    assert.equal(rude.field, 'project_name')
    const noOpu = await ask<Started>(kiosk, 'solo:start', { player: bizPlayer('Aina', 'Retail'), kiosk_id: 'k1' })
    assert.equal(noOpu.field, 'opu')
    assert.equal(noOpu.message, 'Please select your OPU.')
    const noType = await ask<Started>(kiosk, 'solo:start', { player: { ...player('Aina'), affiliation_type: null }, kiosk_id: 'k1' })
    assert.equal(noType.field, 'affiliation_type')
    const noConsent = await ask<Started>(kiosk, 'solo:start', { player: { ...player('Aina'), consent: false }, kiosk_id: 'k1' })
    assert.equal(noConsent.field, 'consent')
    const oldShape = await ask<Started>(kiosk, 'solo:start', { player: { name: 'Aina', department: 'GPE', consent: true }, kiosk_id: 'k1' })
    assert.equal(oldShape.ok, false, 'the old Name + Department shape is refused')

    // The registration check endpoint returns every problem at once (inline errors on the device).
    const v = await http<{ field: string; errors: Record<string, string> }>(srv.url, '/api/players/validate', {
      json: { full_name: '!!!', affiliation_type: 'project', project_name: '', opu: null, consent: true },
    })
    assert.equal(v.status, 400)
    assert.equal(v.body.field, 'full_name')
    assert.deepEqual(v.body.errors, { full_name: 'Please enter your full name.', project_name: 'Please enter your project name.' })
    const good = await http<{ ok: boolean; value: { opu: string; project_name: string | null } }>(srv.url, '/api/players/validate', { json: bizPlayer('Aina Rahman', 'gas & maritime - mlng') })
    assert.equal(good.status, 200)
    assert.equal(good.body.value.opu, 'Gas & Maritime - MLNG', 'stored exactly as written in the OPU list')
    assert.equal(good.body.value.project_name, null)
  })

  it('keeps the best time per player (full name + project name or OPU, any spelling)', async () => {
    const kiosk = await srv.connect()
    const play = async (who: ReturnType<typeof player> | ReturnType<typeof bizPlayer>, solveCount: number) => {
      const s = await ask<Started>(kiosk, 'solo:start', { player: who, kiosk_id: 'k2' })
      const seat = { race_id: s.race.id, run_id: s.run_id, token: s.token }
      srv.advance(COUNTDOWN_MS + 500)
      let p = s.race.runs[0].progress
      for (let i = 0; i < solveCount; i++) p = (await solveOne(kiosk, s.race, seat, p)).progress
      // Use up the clock: the next tap ends the run as "time up".
      srv.advance(40_000)
      const t = s.race.puzzles[p.queue[0]].tiles[0]
      if (solveCount < 6) await ask(kiosk, 'run:tap', { ...seat, puzzle: p.queue[0], tile: t.id })
      return seat
    }
    await play(player('Aina Rahman', 'Jerun'), 3)
    await play(player('aina  rahman', 'JERUN '), 5)
    // Same name from a business OPU is a different player.
    await play(bizPlayer('Aina Rahman', 'Downstream - PETCO'), 2)
    await srv.services.engine.flush()
    const boards = await http<Boards>(srv.url, '/api/boards')
    const aina = boards.body.today.filter((r) => r.name.toLowerCase().includes('aina'))
    assert.equal(aina.length, 2, 'one row per player: Aina (Jerun) and Aina (Downstream - PETCO)')
    const project = aina.find((r) => r.affiliation_type === 'project')!
    assert.equal(project.solved, 5)
    assert.equal(project.affiliation, 'JERUN', 'one spelling each – the tie goes to more capitals (Admin can rename the group)')
    const business = aina.find((r) => r.affiliation_type === 'business')!
    assert.equal(business.affiliation, 'Downstream - PETCO')
    assert.equal(business.solved, 2)
  })

  it('ends the run when the time limit passes even with no taps (server timer)', async () => {
    const s2 = await startServer({ timer_seconds: 1 })
    try {
      const kiosk = await s2.connect()
      const st = await ask<Started>(kiosk, 'solo:start', { player: player('Timer Test'), kiosk_id: 'k3' })
      const ended = await nextState(kiosk, (r) => r.id === st.race.id && r.status === 'finished', COUNTDOWN_MS + 4000)
      assert.equal(ended.runs[0].status, 'timeout')
      assert.equal(ended.runs[0].time_ms, 1000)
    } finally {
      await s2.close()
    }
  })
})

describe('Multiplayer Battle', () => {
  let srv: TestServer
  before(async () => {
    srv = await startServer({ howto_seconds: 0 })
  })
  after(() => srv.close())

  it('lobby → synchronised start → same puzzles → disconnect does not stop the others → winner', async () => {
    const host = await srv.connect()
    const room = await ask<{ ok: boolean; race: RaceState; host_token: string }>(host, 'room:create', { kiosk_id: 'tv-1' })
    assert.ok(room.ok)
    assert.match(room.race.room_code!, /^\d{4}$/)

    const startTooSoon = await ask<{ error: string }>(host, 'room:start', { race_id: room.race.id, host_token: room.host_token })
    assert.equal(startTooSoon.error, 'need_players')

    const phoneA = await srv.connect()
    const phoneB = await srv.connect()
    const phoneC = await srv.connect()
    const a = await ask<Started>(phoneA, 'room:join', { code: room.race.room_code, player: player('Alya', 'Jerun'), device_id: 'pa' })
    const b = await ask<Started>(phoneB, 'room:join', { code: room.race.room_code, player: bizPlayer('Badrul', 'Upstream - SKA'), device_id: 'pb' })
    const c = await ask<Started>(phoneC, 'room:join', { code: room.race.room_code, player: player('Chong', 'GT&C'), device_id: 'pc' })
    assert.ok(a.ok && b.ok && c.ok)
    const badrul = c.race.runs.find((r) => r.id === b.run_id)!
    assert.equal(badrul.name, 'Badrul')
    assert.equal(badrul.affiliation_type, 'business')
    assert.equal(badrul.affiliation, 'Upstream - SKA', 'the lobby shows the OPU')
    const wrongCode = await ask<Started>(phoneC, 'room:join', { code: '0000', player: player('Dina'), device_id: 'pd' })
    assert.equal(wrongCode.error, 'room_not_found')

    // The host removes C before the start.
    const lobby = nextState(host, (r) => r.runs.length === 2)
    assert.ok((await ask<{ ok: boolean }>(host, 'room:kick', { race_id: room.race.id, host_token: room.host_token, run_id: c.run_id })).ok)
    assert.equal((await lobby).runs.length, 2)
    const kicked = await ask<{ ok: boolean; error: string }>(phoneC, 'race:watch', { race_id: room.race.id, run_id: c.run_id, token: c.token })
    assert.equal(kicked.error, 'removed')

    const notHost = await ask<{ error: string }>(phoneA, 'room:start', { race_id: room.race.id, host_token: a.token })
    assert.equal(notHost.error, 'forbidden')

    const runningForA = nextState(phoneA, (r) => r.status === 'running' && r.puzzles.length === 6)
    const runningForB = nextState(phoneB, (r) => r.status === 'running' && r.puzzles.length === 6)
    const started = await ask<{ ok: boolean; race: RaceState }>(host, 'room:start', { race_id: room.race.id, host_token: room.host_token })
    assert.ok(started.ok)
    const [raceA, raceB] = await Promise.all([runningForA, runningForB])
    assert.deepEqual(raceA.puzzles, raceB.puzzles, 'same order and tile shuffle for everyone')
    assert.equal(raceA.go_at, raceB.go_at, 'one synchronised GO')
    const lateJoin = await ask<Started>(phoneC, 'room:join', { code: room.race.room_code, player: player('Late'), device_id: 'pe' })
    assert.equal(lateJoin.error, 'room_started')

    srv.advance(COUNTDOWN_MS + 1000)
    const seatA = { race_id: room.race.id, run_id: a.run_id, token: a.token }
    const seatB = { race_id: room.race.id, run_id: b.run_id, token: b.token }
    let pa = raceA.runs.find((r) => r.id === a.run_id)!.progress
    let pb = raceA.runs.find((r) => r.id === b.run_id)!.progress
    pb = (await solveOne(phoneB, raceA, seatB, pb)).progress
    // B drops out; the race keeps going for A, and the host sees B as disconnected.
    const seesDisconnect = nextState(host, (r) => r.runs.some((x) => x.id === b.run_id && !x.connected), 3000)
    phoneB.disconnect()
    assert.ok(await seesDisconnect, 'big screen shows B as disconnected')
    for (let i = 0; i < 6; i++) pa = (await solveOne(phoneA, raceA, seatA, pa)).progress
    assert.equal(pa.ended, 'finished')

    // B is now out of time; the race finishes with A as the winner.
    srv.advance(40_000)
    const finished = nextState(host, (r) => r.status === 'finished', 6000)
    await srv.services.engine.adminStop(room.race.id)
    const final = await finished
    const ra = final.runs.find((r) => r.id === a.run_id)!
    const rb = final.runs.find((r) => r.id === b.run_id)!
    assert.equal(ra.place, 1)
    assert.equal(ra.is_winner, true)
    assert.equal(rb.place, 2)
    assert.equal(rb.progress.solved.length, 1)

    await srv.services.engine.flush()
    const boards = await http<Boards>(srv.url, '/api/boards')
    assert.equal(boards.body.wins_today[0].name, 'Alya')
    assert.equal(boards.body.wins_today[0].affiliation, 'Jerun')
    assert.equal(boards.body.wins_today[0].wins, 1)
    assert.ok(boards.body.today.some((r) => r.name === 'Badrul' && r.affiliation === 'Upstream - SKA' && r.solved === 1))
  })

  it('refreshing a phone re-attaches to its run with the saved token', async () => {
    const host = await srv.connect()
    const room = await ask<{ race: RaceState; host_token: string }>(host, 'room:create', { kiosk_id: 'tv-2' })
    const phone = await srv.connect()
    const j = await ask<Started>(phone, 'room:join', { code: room.race.room_code, player: player('Refresh Me'), device_id: 'pr' })
    phone.disconnect()
    const again = await srv.connect()
    const w = await ask<{ ok: boolean; race: RaceState }>(again, 'race:watch', { race_id: j.race.id, run_id: j.run_id, token: j.token })
    assert.ok(w.ok)
    assert.ok(w.race.runs.some((r) => r.id === j.run_id && r.connected))
    const stolen = await ask<{ error: string }>(again, 'race:watch', { race_id: j.race.id, run_id: j.run_id, token: 'not-the-token' })
    assert.equal(stolen.error, 'forbidden')
    const full = [] as Started[]
    for (const n of ['Two', 'Three', 'Four']) full.push(await ask<Started>(await srv.connect(), 'room:join', { code: room.race.room_code, player: player(`Player ${n}`), device_id: n }))
    assert.ok(full.every((x) => x.ok), JSON.stringify(full.map((x) => x.error)))
    const fifth = await ask<Started>(await srv.connect(), 'room:join', { code: room.race.room_code, player: player('Player Five'), device_id: 'p5' })
    assert.equal(fifth.error, 'room_full')
    assert.ok((await ask<{ ok: boolean }>(host, 'room:cancel', { race_id: room.race.id, host_token: room.host_token })).ok)
  })
})

describe('Head-to-Head', () => {
  let srv: TestServer
  before(async () => {
    srv = await startServer()
  })
  after(() => srv.close())

  it('two runs on one kiosk, ranked against each other', async () => {
    const kiosk = await srv.connect()
    const res = await ask<{ ok: boolean; race: RaceState; host_token: string; runs: { run_id: string; token: string }[] }>(kiosk, 'h2h:start', {
      players: [player('Left Player', 'PFLNG 3'), bizPlayer('Right Player', 'PE&T - GPE')],
      kiosk_id: 'k-h2h',
    })
    assert.ok(res.ok)
    assert.equal(res.race.runs.length, 2)
    srv.advance(COUNTDOWN_MS + 500)
    const [l, r] = res.runs.map((x) => ({ race_id: res.race.id, run_id: x.run_id, token: x.token }))
    let pl = res.race.runs[0].progress
    let pr = res.race.runs[1].progress
    for (let i = 0; i < 6; i++) {
      pl = (await solveOne(kiosk, res.race, l, pl)).progress
      srv.advance(300)
      pr = (await solveOne(kiosk, res.race, r, pr)).progress
    }
    await srv.services.engine.flush()
    await wait(50)
    const final = await ask<{ race: RaceState }>(kiosk, 'race:watch', { race_id: res.race.id, host_token: res.host_token })
    assert.equal(final.race.status, 'finished')
    assert.equal(final.race.runs.find((x) => x.id === l.run_id)!.place, 1)
    assert.equal(final.race.runs.find((x) => x.id === r.run_id)!.place, 2)
  })
})

describe('Server restart', () => {
  it('resumes a race that was running when the server stopped', async () => {
    const srv = await startServer()
    const kiosk = await srv.connect()
    const s = await ask<Started>(kiosk, 'solo:start', { player: player('Restart Test'), kiosk_id: 'k9' })
    srv.advance(COUNTDOWN_MS + 200)
    const seat = { race_id: s.race.id, run_id: s.run_id, token: s.token }
    const p = (await solveOne(kiosk, s.race, seat, s.race.runs[0].progress)).progress
    kiosk.disconnect()
    await srv.services.engine.flush()
    srv.services.engine.stop()
    // A new engine on the same database (as after a restart).
    const second = await buildApp({ store: srv.store, appVersion: 'test', adminDefaultPin: '1234', clock: srv.clock })
    assert.equal(second.recovered.resumed, 1)
    const state = second.services.engine.state(s.race.id)!
    assert.equal(state.runs[0].progress.solved.length, 1)
    const res = await second.services.engine.tap({ ...seat, puzzle: p.queue[0], tile: s.race.puzzles[p.queue[0]].tiles.find((t) => t.text === s.race.puzzles[p.queue[0]].answer[0].text)!.id })
    assert.ok(['correct', 'solved'].includes(res.outcome))
    second.services.engine.stop()
    await srv.close()
  })
})

export type { Client }
