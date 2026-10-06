import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FeedbackDashboard, FeedbackStatus } from '@shared/feedback'
import { uuid } from '@shared/random'
import { COUNTDOWN_MS } from '@shared/seed'
import { DAY_MS, klDayKey, klDayRange } from '@shared/time'
import type { RaceState } from '@shared/types'
import { adminToken, ask, bizPlayer, http, player, solveOne, startServer, type TestServer } from './helpers'

type Started = { ok: boolean; race: RaceState; run_id: string; token: string }
type GameSeat = { race_id: string; run_id: string; token: string }
type Who = ReturnType<typeof player> | ReturnType<typeof bizPlayer>
type FeedbackRowDb = {
  feedback_id: string
  session_id: string
  player_id: string
  team_id: string | null
  game_mode: string
  q1_relevant: boolean
  q2_would_explore: boolean
  q2_interested_solutions: string[] | null
  q3_understanding_rating: number
  submitted_at: Date | string
  is_test: boolean
  full_name: string
  affiliation_type: string
  project_name: string | null
  opu: string | null
}

const answers = { q1_relevant: true, q2_would_explore: true, q2_interested_solutions: ['sid', 'pcc'], q3_understanding_rating: 4 }

describe('Booth feedback (between the game and the result card)', () => {
  let srv: TestServer
  let token: string

  const status = (seat: GameSeat) => http<FeedbackStatus & { error?: string }>(srv.url, `/api/runs/${seat.run_id}/feedback`, { headers: { 'x-run-token': seat.token } })
  const send = (seat: GameSeat, body: Record<string, unknown> = {}) =>
    http<{ ok?: boolean; status?: string; error?: string }>(srv.url, '/api/feedback', { json: { run_id: seat.run_id, token: seat.token, feedback_id: uuid(), ...answers, ...body } })
  const rowsFor = (runId: string) => srv.store.db.query<FeedbackRowDb>('SELECT * FROM feedback WHERE session_id = $1', [runId])

  /** A Solo game that solves `n` solutions and is then ended (score saved). */
  async function soloGame(who: Who, n = 2): Promise<GameSeat> {
    const s = await srv.connect()
    const st = await ask<Started>(s, 'solo:start', { player: who, kiosk_id: 'fb-test' })
    assert.ok(st.ok, JSON.stringify(st))
    const seat = { race_id: st.race.id, run_id: st.run_id, token: st.token }
    srv.advance(COUNTDOWN_MS + 300)
    let p = st.race.runs[0].progress
    for (let i = 0; i < n; i++) p = (await solveOne(s, st.race, seat, p)).progress
    await srv.services.engine.adminStop(st.race.id)
    await srv.services.engine.flush()
    s.disconnect()
    return seat
  }

  before(async () => {
    srv = await startServer()
    // Play at 10:00 Kuala Lumpur time so no test crosses midnight by accident.
    const now = srv.clock()
    let target = klDayRange(now).start + 10 * 60 * 60 * 1000
    if (target <= now) target += DAY_MS
    srv.advance(target - now)
    token = await adminToken(srv.url)
  })
  after(() => srv.close())

  it('opens only once the score is in the database; all three answers are required', async () => {
    const s = await srv.connect()
    const st = await ask<Started>(s, 'solo:start', { player: player('Score First', 'Jerun'), kiosk_id: 'fb-test' })
    const seat = { race_id: st.race.id, run_id: st.run_id, token: st.token }
    const early = await status(seat)
    assert.equal(early.status, 409, 'no questions while the game is still on')
    assert.equal(early.body.error, 'not_ended')
    assert.equal((await send(seat)).status, 409, 'no answers before the end either')

    srv.advance(COUNTDOWN_MS + 300)
    await solveOne(s, st.race, seat, st.race.runs[0].progress)
    await srv.services.engine.adminStop(st.race.id)
    const ready = await status(seat)
    assert.equal(ready.status, 200)
    assert.deepEqual(ready.body, { score_saved: true, required: true, day: klDayKey(srv.clock()) })
    const saved = await srv.store.getRun(seat.run_id)
    assert.ok(saved && (saved.status === 'finished' || saved.status === 'timeout') && saved.ended_at && saved.solved === 1, 'the score is already saved')

    for (const missing of ['q1_relevant', 'q2_would_explore', 'q3_understanding_rating'] as const) {
      const body: Record<string, unknown> = { run_id: seat.run_id, token: seat.token, feedback_id: uuid(), ...answers }
      delete body[missing]
      assert.equal((await http(srv.url, '/api/feedback', { json: body })).status, 400, `${missing} is required`)
    }
    assert.equal((await send(seat, { q3_understanding_rating: 6 })).status, 400, 'stars are 1–5')
    assert.equal((await send(seat, { q1_relevant: 'yes' })).status, 400, 'yes / no only')
    assert.equal((await send(seat, { feedback_id: 'not-a-uuid' })).status, 400)
    assert.equal((await send({ ...seat, token: 'wrong' })).status, 404, 'only the device that played can answer')
    assert.equal((await rowsFor(seat.run_id)).length, 0)

    const ok = await send(seat)
    assert.equal(ok.status, 200)
    assert.equal(ok.body.status, 'saved')
    const [row] = await rowsFor(seat.run_id)
    assert.equal(row.full_name, 'Score First')
    assert.equal(row.affiliation_type, 'project')
    assert.equal(row.project_name, 'Jerun')
    assert.equal(row.opu, null)
    assert.equal(row.game_mode, 'solo')
    assert.equal(row.team_id, null)
    assert.equal(row.is_test, false)
    assert.deepEqual(row.q2_interested_solutions, ['sid', 'pcc'])
    s.disconnect()
  })

  it('solution chips count only with a Yes to question 2', async () => {
    const no = await soloGame(player('Chip Tester', 'Jerun'))
    assert.equal((await send(no, { q2_would_explore: false, q2_interested_solutions: ['sid'] })).status, 200)
    assert.equal((await rowsFor(no.run_id))[0].q2_interested_solutions, null, 'switching to No clears the chips')
    const yes = await soloGame(player('Chip Picker', 'Jerun'))
    assert.equal((await send(yes, { q2_interested_solutions: ['ppm', 'not-a-solution', 'ppm'] })).status, 200)
    assert.deepEqual((await rowsFor(yes.run_id))[0].q2_interested_solutions, ['ppm'], 'unknown ids dropped, no repeats')
    const none = await soloGame(player('Chip Skipper', 'Jerun'))
    assert.equal((await send(none, { q2_interested_solutions: [] })).status, 200)
    assert.equal((await rowsFor(none.run_id))[0].q2_interested_solutions, null, 'chips are optional')
  })

  it('asks once per player per day (full name + project / OPU, like the leaderboard); a replay skips it', async () => {
    const first = await soloGame(player('Nur Aisyah', 'Kasawari CCS'))
    assert.equal((await status(first)).body.required, true)
    assert.equal((await send(first)).status, 200)

    // Play again with different capitals and spaces: the same player.
    const replay = await soloGame(player('  NUR   aisyah ', 'kasawari  ccs'))
    assert.equal((await status(replay)).body.required, false, 'the replay goes straight to the result card')
    const twice = await send(replay)
    assert.equal(twice.status, 409)
    assert.equal(twice.body.error, 'already_given')
    assert.equal((await rowsFor(replay.run_id)).length, 0)

    // Another project is another player …
    const other = await soloGame(player('Nur Aisyah', 'Jerun Phase 2'))
    assert.equal((await status(other)).body.required, true)
    // … until Admin merges the project names (as on the boards).
    const merge = await http(srv.url, '/api/admin/projects/merge', { json: { keys: ['jerun phase 2', 'kasawari ccs'], target: 'kasawari ccs' }, token })
    assert.equal(merge.status, 200)
    assert.equal((await status(other)).body.required, false, 'merged project = same player')
    assert.equal((await http(srv.url, '/api/admin/projects/unmerge', { json: { key: 'jerun phase 2' }, token })).status, 200)

    // An OPU player: name + OPU.
    const biz = await soloGame(bizPlayer('Nur Aisyah', 'Upstream - PMA'))
    assert.equal((await status(biz)).body.required, true, 'same name from an OPU is a different player')
    assert.equal((await send(biz)).status, 200)
    assert.equal((await status(await soloGame(bizPlayer('nur aisyah', 'upstream - pma')))).body.required, false)

    // The next Kuala Lumpur day asks again.
    srv.advance(DAY_MS)
    const tomorrow = await soloGame(player('Nur Aisyah', 'Kasawari CCS'))
    assert.equal((await status(tomorrow)).body.required, true)
    assert.equal((await send(tomorrow)).status, 200)
    const days = await srv.store.db.query<{ d: string }>(
      `SELECT (f.submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date::text AS d FROM feedback f WHERE f.player_id = (SELECT player_id FROM runs WHERE id = $1) ORDER BY 1`,
      [first.run_id],
    )
    assert.equal(days.length, 2)
    assert.notEqual(days[0].d, days[1].d)

    // The database refuses a second answer on the same day even without the service check.
    const run = (await srv.store.getRun(tomorrow.run_id))!
    const dup = await srv.store.insertFeedback({
      feedback_id: uuid(), session_id: run.id, player_id: run.player_id, team_id: null, full_name: run.full_name, affiliation_type: run.affiliation_type,
      project_name: run.project_name, opu: run.opu, q1_relevant: true, q2_would_explore: false, q2_interested_solutions: null, q3_understanding_rating: 3,
      game_mode: 'solo', submitted_at: srv.clock(), is_test: false,
    })
    assert.equal(dup, false, 'unique per player per day')
  })

  it('team mode: every Battle player answers on their own phone, and each Head-to-Head player separately', async () => {
    const host = await srv.connect()
    const room = await ask<{ ok: boolean; race: RaceState; host_token: string }>(host, 'room:create', { kiosk_id: 'fb-tv' })
    const pa = await srv.connect()
    const pb = await srv.connect()
    const a = await ask<Started>(pa, 'room:join', { code: room.race.room_code, player: player('Team Alya', 'Jerun'), device_id: 'fa' })
    const b = await ask<Started>(pb, 'room:join', { code: room.race.room_code, player: bizPlayer('Team Badrul', 'Upstream - SKA'), device_id: 'fb' })
    assert.ok(a.ok && b.ok)
    assert.ok((await ask<{ ok: boolean }>(host, 'room:start', { race_id: room.race.id, host_token: room.host_token })).ok)
    srv.advance(COUNTDOWN_MS + 30_000)
    await srv.services.engine.adminStop(room.race.id)
    await srv.services.engine.flush()
    const seatA = { race_id: room.race.id, run_id: a.run_id, token: a.token }
    const seatB = { race_id: room.race.id, run_id: b.run_id, token: b.token }
    assert.equal((await status(seatA)).body.required, true)
    assert.equal((await status(seatB)).body.required, true)
    assert.equal((await send(seatA, { q1_relevant: true })).status, 200)
    assert.equal((await status(seatB)).body.required, true, "one player's answer never counts for another")
    assert.equal((await send(seatB, { q1_relevant: false, q2_would_explore: false, q2_interested_solutions: null })).status, 200)
    assert.equal((await send(seatB, {}, )).status, 409, "a phone can't answer for a teammate twice")
    const [ra] = await rowsFor(a.run_id)
    const [rb] = await rowsFor(b.run_id)
    assert.equal(ra.game_mode, 'team')
    assert.equal(ra.team_id, room.race.id)
    assert.equal(rb.team_id, room.race.id)
    assert.equal(rb.opu, 'Upstream - SKA')
    assert.equal(rb.q1_relevant, false)

    const kiosk = await srv.connect()
    const h2h = await ask<{ ok: boolean; race: RaceState; runs: { run_id: string; token: string }[] }>(kiosk, 'h2h:start', {
      players: [player('Left Lina', 'PFLNG 3'), bizPlayer('Right Rizal', 'PE&T - GPE')],
      kiosk_id: 'fb-h2h',
    })
    assert.ok(h2h.ok)
    srv.advance(COUNTDOWN_MS + 30_000)
    await srv.services.engine.adminStop(h2h.race.id)
    await srv.services.engine.flush()
    for (const r of h2h.runs) {
      const seat = { race_id: h2h.race.id, run_id: r.run_id, token: r.token }
      assert.equal((await status(seat)).body.required, true)
      assert.equal((await send(seat)).status, 200)
      assert.equal((await rowsFor(r.run_id))[0].game_mode, 'team')
    }
    for (const c of [host, pa, pb, kiosk]) c.disconnect()
  })

  it('an answer sent again after the phone was offline is stored exactly once, with the time it was given', async () => {
    const seat = await soloGame(player('Offline Olivia', 'Jerun'))
    const run = (await srv.store.getRun(seat.run_id))!
    const answeredAt = run.ended_at! + 4000
    const body = { feedback_id: uuid(), answered_at: answeredAt }
    // The phone comes back online two minutes later and sends the stored answer (several times).
    srv.advance(120_000)
    const first = await send(seat, body)
    assert.equal(first.status, 200)
    assert.equal(first.body.status, 'saved')
    const retries = await Promise.all([send(seat, body), send(seat, body), send(seat, body)])
    assert.ok(retries.every((r) => r.status === 200 && r.body.status === 'duplicate'), JSON.stringify(retries.map((r) => r.body)))
    const rows = await rowsFor(seat.run_id)
    assert.equal(rows.length, 1, 'no duplicates')
    assert.equal(new Date(rows[0].submitted_at).getTime(), answeredAt, 'kept the moment it was answered')

    // Device clocks can be wrong: never before the game ended, never in the future.
    const late = await soloGame(player('Clock Skew', 'Jerun'))
    assert.equal((await send(late, { answered_at: srv.clock() + 3_600_000 })).status, 200)
    assert.ok(new Date((await rowsFor(late.run_id))[0].submitted_at).getTime() <= srv.clock())
    const early = await soloGame(player('Clock Early', 'Jerun'))
    const earlyRun = (await srv.store.getRun(early.run_id))!
    assert.equal((await send(early, { answered_at: 0 })).status, 200)
    assert.equal(new Date((await rowsFor(early.run_id))[0].submitted_at).getTime(), earlyRun.ended_at)
  })

  it('Admin: numbers match the database, rehearsal answers are left out, filters and exports work', async () => {
    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { rehearsal_mode: true }, token })
    const rehearsal = await soloGame(player('Rehearsal Feedback', 'Booth Team'))
    assert.equal((await send(rehearsal)).status, 200)
    assert.equal((await rowsFor(rehearsal.run_id))[0].is_test, true)
    await http(srv.url, '/api/admin/settings', { method: 'PUT', json: { rehearsal_mode: false }, token })

    const d = (await http<FeedbackDashboard>(srv.url, '/api/admin/feedback', { token })).body
    const db = srv.store.db
    const [sql] = await db.query<{ n: number; q1: number; q2: number; avg: number | null }>(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE q1_relevant)::int AS q1, count(*) FILTER (WHERE q2_would_explore)::int AS q2,
              avg(q3_understanding_rating)::float8 AS avg FROM feedback WHERE is_test = false`,
    )
    assert.ok(sql.n >= 10, `${sql.n} answers so far`)
    assert.equal(d.responses, sql.n)
    assert.deepEqual(d.q1, { yes: sql.q1, no: sql.n - sql.q1 })
    assert.deepEqual(d.q2, { yes: sql.q2, no: sql.n - sql.q2 })
    assert.ok(Math.abs(d.q3.average! - sql.avg!) < 1e-9)
    const dist = await db.query<{ r: number; n: number }>('SELECT q3_understanding_rating AS r, count(*)::int AS n FROM feedback WHERE is_test = false GROUP BY 1')
    for (const x of d.q3.distribution) assert.equal(x.count, dist.find((y) => y.r === x.rating)?.n ?? 0, `${x.rating} stars`)
    const [games] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM runs WHERE status IN ('finished', 'timeout') AND ended_at IS NOT NULL AND is_test = false`)
    assert.equal(d.completed_games, games.n)
    assert.equal(d.response_rate, sql.n / games.n)
    const interest = await db.query<{ s: string; n: number }>(
      `SELECT s, count(DISTINCT player_id)::int AS n FROM feedback, unnest(q2_interested_solutions) AS s WHERE is_test = false AND q2_would_explore GROUP BY s`,
    )
    for (const s of d.solutions) assert.equal(s.players, interest.find((x) => x.s === s.id)?.n ?? 0, s.id)
    assert.deepEqual(
      d.solutions.map((s) => s.players),
      [...d.solutions.map((s) => s.players)].sort((a, b) => b - a),
      'highest first',
    )
    assert.equal(d.rehearsal_responses, 1)
    assert.ok(!d.by_project.some((p) => p.label === 'Booth Team'), 'rehearsal left out of the breakdown')
    const [biz] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM feedback WHERE is_test = false AND opu = 'Upstream - SKA'`)
    assert.equal(d.by_opu.find((o) => o.label === 'Upstream - SKA')?.responses, biz.n)

    // Filters
    const team = (await http<FeedbackDashboard>(srv.url, '/api/admin/feedback?mode=team', { token })).body
    assert.equal(team.responses, 4, 'battle (2) + head-to-head (2)')
    const business = (await http<FeedbackDashboard>(srv.url, '/api/admin/feedback?affiliation=business', { token })).body
    const [bizAll] = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM feedback WHERE is_test = false AND affiliation_type = 'business'`)
    assert.equal(business.responses, bizAll.n)
    const opu = (await http<FeedbackDashboard>(srv.url, `/api/admin/feedback?opu=${encodeURIComponent('Upstream - SKA')}`, { token })).body
    assert.equal(opu.responses, biz.n)
    assert.equal(opu.filter.affiliation, 'business')
    const today = klDayKey(srv.clock())
    const day = (await http<FeedbackDashboard>(srv.url, `/api/admin/feedback?from=${today}&to=${today}`, { token })).body
    const [todays] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM feedback WHERE is_test = false AND (submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date = $1::date`,
      [today],
    )
    assert.equal(day.responses, todays.n)
    assert.ok(day.responses < d.responses, 'yesterday is filtered out')

    // Exports (same filters, rehearsal left out)
    const csv = await http<ArrayBuffer>(srv.url, '/api/admin/feedback/export.csv?mode=team', { token })
    assert.equal(csv.status, 200)
    const text = Buffer.from(csv.body).toString('utf8')
    assert.ok(text.startsWith('﻿"Submitted (KL)","Full name","From","Project name","Project group","OPU","Game mode","Game","Q1 Relevant"'), text.slice(0, 200))
    assert.equal(text.trim().split('\r\n').length, 1 + team.responses)
    assert.ok(!text.includes('Rehearsal Feedback'))
    const xlsx = await http<ArrayBuffer>(srv.url, '/api/admin/feedback/export.xlsx', { token })
    assert.equal(xlsx.status, 200)
    assert.equal(Buffer.from(xlsx.body).subarray(0, 2).toString(), 'PK')
    assert.equal((await http(srv.url, '/api/admin/feedback')).status, 401, 'Admin only')

    // Deleting rehearsal data removes rehearsal answers too.
    const del = await http(srv.url, '/api/admin/test-data/delete', { json: { pin: '482915' }, token })
    assert.equal(del.status, 200)
    const [left] = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM feedback WHERE is_test = true')
    assert.equal(left.n, 0)
  })
})
