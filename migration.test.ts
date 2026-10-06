import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_OPUS, PREVIOUS_DEFAULT_OPUS } from '@shared/seed'
import { openDb } from '../../server/db/db'
import { MIGRATIONS, runMigrations } from '../../server/db/migrations'
import { Store } from '../../server/db/store'

describe('migration 002_affiliation (Department → Project / OPU)', () => {
  it('keeps every existing department as a project name, with keys, merges and labels intact', async () => {
    const db = await openDb({ dataDir: 'memory://' })
    try {
      // A database as it was before the new registration form.
      await db.exec('CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      await db.exec(MIGRATIONS[0].sql)
      await db.query(`INSERT INTO schema_migrations (id) VALUES ('001_core')`)
      const player = '00000000-0000-4000-8000-000000000001'
      const race = '00000000-0000-4000-8000-000000000002'
      const run = '00000000-0000-4000-8000-000000000003'
      await db.query(`INSERT INTO players (id, name, department, name_key, dept_key) VALUES ($1, 'Aina Rahman', 'GT & C', 'aina rahman', 'gt&c')`, [player])
      await db.query(`INSERT INTO races (id, mode, status, rules, puzzles, ended_at) VALUES ($1, 'solo', 'finished', '{}'::jsonb, '[]'::jsonb, now())`, [race])
      await db.query(
        `INSERT INTO runs (id, race_id, player_id, lane, name, department, token_hash, status, progress, solved, time_ms, ended_at)
         VALUES ($1, $2, $3, 0, 'Aina Rahman', 'GT & C', 'x', 'finished', '{}'::jsonb, 6, 20000, now())`,
        [run, race, player],
      )
      await db.query(`INSERT INTO department_aliases (alias_key, target_key) VALUES ('gtc', 'gt&c')`)
      await db.query(`INSERT INTO department_labels (dept_key, label) VALUES ('gt&c', 'GT&C')`)
      await db.query(`INSERT INTO settings (key, value) VALUES ('interest_question', '"Which Nerv Centre solution interests you most?"'::jsonb)`)

      const ran = await runMigrations(db)
      assert.ok(ran.includes('002_affiliation'))

      const [p] = await db.query('SELECT full_name, affiliation_type, project_name, opu, affil_key FROM players')
      assert.deepEqual(p, { full_name: 'Aina Rahman', affiliation_type: 'project', project_name: 'GT & C', opu: null, affil_key: 'p:gt&c' })
      const store = new Store(db)
      const [r] = await store.endedRuns()
      assert.equal(r.full_name, 'Aina Rahman')
      assert.equal(r.affiliation_type, 'project')
      assert.equal(r.project_name, 'GT & C')
      assert.equal(r.opu, null)
      assert.deepEqual([...(await store.projectAliases())], [['gtc', 'gt&c']])
      assert.deepEqual([...(await store.projectLabels())], [['gt&c', 'GT&C']])
      assert.equal((await store.getSettings()).interest_question, 'Which digital solution interests you most?', 'old wording replaced')

      const cols = await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('players', 'runs') AND column_name IN ('department', 'name', 'dept_key')`)
      assert.deepEqual(cols, [], 'the old columns are gone')
      await assert.rejects(db.query(`UPDATE players SET affiliation_type = 'department'`), 'only project or business is allowed')
      assert.deepEqual(await runMigrations(db), [], 'runs once')
    } finally {
      await db.close()
    }
  })
})

describe('migration 003_opu_entities (OPU list → entity list)', () => {
  /** A database at 002 with the given OPU list saved in settings. */
  async function at002(opus: string[]) {
    const db = await openDb({ dataDir: 'memory://' })
    await db.exec('CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
    for (const m of MIGRATIONS.filter((x) => x.id < '003')) {
      await db.exec(m.sql)
      await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id])
    }
    await db.query(`INSERT INTO settings (key, value) VALUES ('opus', $1::jsonb)`, [JSON.stringify(opus)])
    return db
  }

  it('replaces the first default OPU list (saved unchanged) with the new list ending in "Others"', async () => {
    const db = await at002(PREVIOUS_DEFAULT_OPUS)
    try {
      assert.ok((await runMigrations(db)).includes('003_opu_entities'))
      assert.deepEqual((await new Store(db).getSettings()).opus, DEFAULT_OPUS)
    } finally {
      await db.close()
    }
  })

  it('leaves a list that Admin already edited alone', async () => {
    const edited = [...PREVIOUS_DEFAULT_OPUS, 'PETRONAS Dagangan']
    const db = await at002(edited)
    try {
      await runMigrations(db)
      assert.deepEqual((await new Store(db).getSettings()).opus, edited)
    } finally {
      await db.close()
    }
  })
})

describe('migration 004_feedback_questions (optional feedback → three questions once a day)', () => {
  it('keeps earlier answers in feedback_legacy and creates the new feedback table', async () => {
    const db = await openDb({ dataDir: 'memory://' })
    try {
      await db.exec('CREATE TABLE schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
      for (const m of MIGRATIONS.filter((x) => x.id < '004')) {
        await db.exec(m.sql)
        await db.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id])
      }
      const player = '00000000-0000-4000-8000-000000000011'
      const race = '00000000-0000-4000-8000-000000000012'
      const run = '00000000-0000-4000-8000-000000000013'
      await db.query(`INSERT INTO players (id, full_name, affiliation_type, project_name, name_key, affil_key) VALUES ($1, 'Aina', 'project', 'Jerun', 'aina', 'p:jerun')`, [player])
      await db.query(`INSERT INTO races (id, mode, status, rules, puzzles, ended_at) VALUES ($1, 'solo', 'finished', '{}'::jsonb, '[]'::jsonb, now())`, [race])
      await db.query(
        `INSERT INTO runs (id, race_id, player_id, lane, full_name, affiliation_type, project_name, token_hash, status, progress, solved, time_ms, ended_at)
         VALUES ($1, $2, $3, 0, 'Aina', 'project', 'Jerun', 'x', 'finished', '{}'::jsonb, 6, 20000, now())`,
        [run, race, player],
      )
      await db.query(`INSERT INTO feedback (id, run_id, rating, interest, comment) VALUES ('00000000-0000-4000-8000-000000000014', $1, 5, 'sid', 'Great booth!')`, [run])

      assert.ok((await runMigrations(db)).includes('004_feedback_questions'))
      const legacy = await db.query<{ rating: number; comment: string }>('SELECT rating, comment FROM feedback_legacy')
      assert.deepEqual(legacy, [{ rating: 5, comment: 'Great booth!' }], 'earlier answers are kept')
      const cols = (await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'feedback' ORDER BY ordinal_position`)).map((c) => c.column_name)
      assert.deepEqual(cols, [
        'feedback_id', 'session_id', 'player_id', 'team_id', 'full_name', 'affiliation_type', 'project_name', 'opu', 'q1_relevant', 'q2_would_explore',
        'q2_interested_solutions', 'q3_understanding_rating', 'game_mode', 'submitted_at', 'is_test',
      ])
      const insert = (id: string, at: string) =>
        db.query(
          `INSERT INTO feedback (feedback_id, session_id, player_id, full_name, affiliation_type, q1_relevant, q2_would_explore, q3_understanding_rating, game_mode, submitted_at)
           VALUES ($1, $2, $3, 'Aina', 'project', true, false, 4, 'solo', $4)`,
          [id, run, player, at],
        )
      await insert('00000000-0000-4000-8000-000000000021', '2026-10-05T01:00:00Z')
      await assert.rejects(insert('00000000-0000-4000-8000-000000000022', '2026-10-05T15:59:59Z'), 'same KL day (09:00 and 23:59)')
      await insert('00000000-0000-4000-8000-000000000023', '2026-10-05T16:00:00Z') // 00:00 the next KL day
      await assert.rejects(
        db.query(`UPDATE feedback SET q2_interested_solutions = ARRAY['sid'] WHERE feedback_id = '00000000-0000-4000-8000-000000000021'`),
        'solutions only with a Yes to question 2',
      )
      await assert.rejects(db.query(`UPDATE feedback SET q3_understanding_rating = 6`), 'stars are 1–5')
      assert.deepEqual(await runMigrations(db), [], 'runs once')
    } finally {
      await db.close()
    }
  })

  it('a fresh database gets every migration, the new feedback table included', async () => {
    const db = await openDb({ dataDir: 'memory://' })
    try {
      assert.deepEqual(await runMigrations(db), MIGRATIONS.map((m) => m.id))
      const tables = (await db.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'feedback%' ORDER BY 1`)).map((t) => t.table_name)
      assert.deepEqual(tables, ['feedback', 'feedback_legacy'])
    } finally {
      await db.close()
    }
  })
})
