import type { Db } from './db'

/**
 * Ordered, append-only schema migrations (PostgreSQL dialect).
 * Never edit a migration that has shipped – add a new one.
 */
export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_core',
    sql: /* sql */ `
      CREATE TABLE settings (
        key         text PRIMARY KEY,
        value       jsonb NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE solutions (
        id           text PRIMARY KEY,
        position     int NOT NULL,
        name         text NOT NULL,
        clue         text NOT NULL,
        description  text NOT NULL DEFAULT '',
        decoys       jsonb NOT NULL DEFAULT '[]',
        updated_at   timestamptz NOT NULL DEFAULT now()
      );

      -- A player is recognised by normalised name + department (best time per player).
      CREATE TABLE players (
        id            uuid PRIMARY KEY,
        name          text NOT NULL,
        department    text NOT NULL,
        name_key      text NOT NULL,
        dept_key      text NOT NULL,
        created_at    timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (name_key, dept_key)
      );

      CREATE TABLE races (
        id               uuid PRIMARY KEY,
        mode             text NOT NULL CHECK (mode IN ('solo', 'battle', 'h2h')),
        status           text NOT NULL CHECK (status IN ('lobby', 'howto', 'running', 'finished', 'cancelled')),
        room_code        text,
        rules            jsonb NOT NULL,
        puzzles          jsonb NOT NULL DEFAULT '[]',
        host_token_hash  text,
        kiosk_id         text,
        is_test          boolean NOT NULL DEFAULT false,
        created_at       timestamptz NOT NULL DEFAULT now(),
        howto_ends_at    timestamptz,
        go_at            timestamptz,
        ended_at         timestamptz,
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX races_status ON races (status);

      CREATE TABLE runs (
        id              uuid PRIMARY KEY,
        race_id         uuid NOT NULL REFERENCES races(id) ON DELETE CASCADE,
        player_id       uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        lane            int NOT NULL,
        name            text NOT NULL,
        department      text NOT NULL,
        token_hash      text NOT NULL,
        device_id       text,
        status          text NOT NULL CHECK (status IN ('waiting', 'playing', 'finished', 'timeout', 'left')),
        progress        jsonb NOT NULL,
        solved          int NOT NULL DEFAULT 0,
        time_ms         int,
        penalty_ms      int NOT NULL DEFAULT 0,
        wrong           int NOT NULL DEFAULT 0,
        skips           int NOT NULL DEFAULT 0,
        place           int,
        is_winner       boolean NOT NULL DEFAULT false,
        is_test         boolean NOT NULL DEFAULT false,
        consent_at      timestamptz NOT NULL DEFAULT now(),
        removed_at      timestamptz,
        removed_reason  text,
        created_at      timestamptz NOT NULL DEFAULT now(),
        ended_at        timestamptz,
        updated_at      timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX runs_race ON runs (race_id);
      CREATE INDEX runs_player ON runs (player_id);
      CREATE INDEX runs_ended ON runs (ended_at);

      CREATE TABLE feedback (
        id          uuid PRIMARY KEY,
        run_id      uuid NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        rating      int CHECK (rating BETWEEN 1 AND 5),
        interest    text,
        comment     text,
        hidden      boolean NOT NULL DEFAULT false,
        is_test     boolean NOT NULL DEFAULT false,
        created_at  timestamptz NOT NULL DEFAULT now()
      );

      -- Admin department merges: alias group key → target group key; optional label overrides.
      CREATE TABLE department_aliases (
        alias_key   text PRIMARY KEY,
        target_key  text NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE department_labels (
        dept_key    text PRIMARY KEY,
        label       text NOT NULL,
        updated_at  timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE admin_users (
        id               uuid PRIMARY KEY,
        pin_hash         text NOT NULL,
        must_change_pin  boolean NOT NULL DEFAULT true,
        failed_attempts  int NOT NULL DEFAULT 0,
        locked_until     timestamptz,
        last_login_at    timestamptz,
        created_at       timestamptz NOT NULL DEFAULT now(),
        updated_at       timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE admin_sessions (
        token_hash  text PRIMARY KEY,
        user_id     uuid NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
        expires_at  timestamptz NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_log (
        id       bigserial PRIMARY KEY,
        at       timestamptz NOT NULL DEFAULT now(),
        action   text NOT NULL,
        details  jsonb NOT NULL DEFAULT '{}'
      );
    `,
  },
  {
    // Registration changed from "Name + Department" to "Full name + Project (name) or Business (OPU)".
    // Existing departments are kept as project names (type 'project') so no data is lost.
    id: '002_affiliation',
    sql: /* sql */ `
      ALTER TABLE players RENAME COLUMN name TO full_name;
      ALTER TABLE players ADD COLUMN affiliation_type text NOT NULL DEFAULT 'project';
      ALTER TABLE players ADD COLUMN project_name text;
      ALTER TABLE players ADD COLUMN opu text;
      UPDATE players SET project_name = department;
      ALTER TABLE players DROP COLUMN department;
      ALTER TABLE players RENAME COLUMN dept_key TO affil_key;
      UPDATE players SET affil_key = 'p:' || affil_key;
      ALTER TABLE players ALTER COLUMN affiliation_type DROP DEFAULT;
      ALTER TABLE players ADD CONSTRAINT players_affiliation_type_check CHECK (affiliation_type IN ('project', 'business'));

      ALTER TABLE runs RENAME COLUMN name TO full_name;
      ALTER TABLE runs ADD COLUMN affiliation_type text NOT NULL DEFAULT 'project';
      ALTER TABLE runs ADD COLUMN project_name text;
      ALTER TABLE runs ADD COLUMN opu text;
      UPDATE runs SET project_name = department;
      ALTER TABLE runs DROP COLUMN department;
      ALTER TABLE runs ALTER COLUMN affiliation_type DROP DEFAULT;
      ALTER TABLE runs ADD CONSTRAINT runs_affiliation_type_check CHECK (affiliation_type IN ('project', 'business'));

      -- Department merges become project-name merges (same keys).
      ALTER TABLE department_aliases RENAME TO project_aliases;
      ALTER TABLE department_labels RENAME TO project_labels;
      ALTER TABLE project_labels RENAME COLUMN dept_key TO project_key;

      -- Old default wording that is no longer used on screen.
      UPDATE settings SET value = '"Which digital solution interests you most?"'::jsonb
       WHERE key = 'interest_question' AND value = '"Which Nerv Centre solution interests you most?"'::jsonb;
      UPDATE settings SET value = '"PMX Digital Challenge"'::jsonb
       WHERE key = 'event_title' AND value = '"Nerv Centre Solutions Word Rush"'::jsonb;
    `,
  },
  {
    // The OPU list became the entity list ("Downstream - MRCSB" … "Others"). A list that was saved
    // unchanged from the first default is replaced; a list Admin edited is left alone.
    id: '003_opu_entities',
    sql: /* sql */ `
      UPDATE settings SET updated_at = now(), value = '[
        "Downstream - MRCSB", "Downstream - PC MTBE", "Downstream - PCEPE", "Downstream - PCFKSB", "Downstream - PCGCo",
        "Downstream - PCMSB", "Downstream - PCOGD", "Downstream - PDB", "Downstream - PETCO", "Downstream - PLISB",
        "Downstream - PP(T)SB", "Downstream - PRPC Group", "Gas & Maritime - MLNG", "Gas & Maritime - PGB GPU",
        "PE&T - GPE", "PE&T - PDSB", "PE&T - PRSB", "Upstream - MPM", "Upstream - PMA", "Upstream - SBA", "Upstream - SKA",
        "Others"
      ]'::jsonb
       WHERE key = 'opus' AND value = '[
        "Upstream", "Downstream", "Gas & Maritime", "Project, Engineering and Technology", "Malaysia Petroleum Management",
        "Finance", "Corporate Sustainability", "Group Corporate Governance & Secretarial"
      ]'::jsonb;
    `,
  },
  {
    // The optional booth feedback (rating / interest / comment after the results) became three one-tap
    // questions between the game and the result card, asked once per player per day. Earlier answers
    // stay in feedback_legacy (and in backups).
    id: '004_feedback_questions',
    sql: /* sql */ `
      ALTER TABLE feedback RENAME TO feedback_legacy;
      ALTER INDEX feedback_pkey RENAME TO feedback_legacy_pkey;
      ALTER INDEX feedback_run_id_key RENAME TO feedback_legacy_run_id_key;

      CREATE TABLE feedback (
        feedback_id              uuid PRIMARY KEY,
        session_id               uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        player_id                uuid NOT NULL REFERENCES players(id) ON DELETE CASCADE,
        team_id                  uuid REFERENCES races(id) ON DELETE CASCADE,
        -- Copied from the game for easy reporting.
        full_name                text NOT NULL,
        affiliation_type         text NOT NULL CHECK (affiliation_type IN ('project', 'business')),
        project_name             text,
        opu                      text,
        q1_relevant              boolean NOT NULL,
        q2_would_explore         boolean NOT NULL,
        q2_interested_solutions  text[],
        q3_understanding_rating  int NOT NULL CHECK (q3_understanding_rating BETWEEN 1 AND 5),
        game_mode                text NOT NULL CHECK (game_mode IN ('solo', 'team')),
        submitted_at             timestamptz NOT NULL DEFAULT now(),
        is_test                  boolean NOT NULL DEFAULT false,
        CONSTRAINT feedback_solutions_need_yes CHECK (q2_would_explore OR q2_interested_solutions IS NULL)
      );
      -- One answer per player per KL day (rehearsal answers are counted separately).
      CREATE UNIQUE INDEX feedback_one_per_player_per_day
        ON feedback (player_id, ((submitted_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date), is_test);
      CREATE INDEX feedback_session ON feedback (session_id);
      CREATE INDEX feedback_submitted ON feedback (submitted_at);
    `,
  },
]

export async function runMigrations(db: Db): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  )
  const applied = new Set((await db.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id))
  const ran: string[] = []
  for (const m of MIGRATIONS) {
    if (applied.has(m.id)) continue
    await db.transaction(async (tx) => {
      await tx.exec(m.sql)
      await tx.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id])
    })
    ran.push(m.id)
  }
  return ran
}
