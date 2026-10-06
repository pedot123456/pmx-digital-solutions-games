# PMX Digital Challenge – Word Rush

**Can you light up all six digital solutions in 30 seconds?**

The PMX Digital Challenge booth game: a touchscreen, multiplayer word puzzle for the Technology Digital Solutions
booth at PETRONAS events. Players build the names of the six digital solutions from word tiles. Every name built
lights one star of the constellation – a constellation that traces the "N" of the NERVCENTRE logo. Light all six and
the constellation glows and reveals the logo. The fastest time wins.

This app replaces the earlier single-file *PMX Digital Challenge* quiz (that folder is unchanged but no longer the
game to run). The home page keeps the PMX Digital Challenge look: PMX header, the PETRONAS + NERVCENTRE logos, the
title, a big **Tap to Begin** button, today's **Top Players with their project or OPU**, and the PMX solutions ticker.

**Colours** – only the five PMX colours: **Blue #20419A** (backgrounds and structure), **Soft Green #BFD730** (main
buttons, selected tiles and toggles), **Green #00A19C** (correct / done, the registration Start button), **Yellow
#FDB924** (timer, 1st place) and **Purple #763F98** (multiplayer, star glow). Red #D83B3E appears only for a wrong tile
or an error message. Dashboard charts use a lighter step of the brand Blue (#3f86e6) because the brand Blue and Purple
are hard to tell apart for colour-blind viewers.

| Phase | Scope | Status |
|---|---|---|
| **1 – Solo Rush** | ~1 s logo splash, PMX home page with Tap to Begin and live Top Players, registration (full name, Project or Business, project name or OPU, PDPA consent), 10 s How to Play, synchronised 3-2-1-GO, the game (clue, word tiles, decoys, +1 s wrong tile, Skip +2 s, Hard Mode letter tiles, yellow timer that turns red with ticks in the last 5 s), constellation reveal, booth feedback (3 one-tap questions before the result card, once per player per day), results with learning recap, leaderboards, server-side timing, refresh-proof games, Admin basics (PIN, solutions/clues/decoys, timer, penalties, Hard Mode, results, remove entries, reset daily board, rehearsal mode) | **Done** |
| **2 – Multiplayer Battle + display** | Lobby with 4-digit room code + QR on the big screen, 2–4 players on their own phones (same registration form), same solutions/order/tile shuffle for everyone, synchronised How to Play and 3-2-1-GO, live race view, disconnect handling, battle results and the Multiplayer wins board, `#/display` TV screen | **Done** |
| **3 – Head-to-Head, dashboard, exports** | Two players on one touchscreen (left vs right, simultaneous touch), feedback dashboard and analytics (Project vs Business, players by OPU, players by project name), project-name grouping + merge tool, editable OPU list, CSV and Excel exports, backups, test-data removal, audit log | **Done** |

**Sample content:** the six solution names are from the brief. The clues are the brief's examples; the recap lines
for SID, PTQ Online, PPM and PCC follow the PMX catalogue, and those for Project AI and PDSB Services repeat the
brief's clue wording. Everything – names, clues, recap lines and decoys – is editable in **Admin → Solutions & decoys**.

---

## 0. Run it online – players on their own phones (Render)

The game is one Node.js server (pages + API + live game server with Socket.IO and server-side timing), so it runs
on a host that keeps a server process running – **Render** – with the data in a hosted **PostgreSQL** database.
(Vercel only runs short serverless functions: it can't keep live races, timers or WebSocket connections, so it
can't host this game.)

1. **Database (keeps every game and answer):** create a free account at <https://neon.tech> → *New project* →
   region **AWS Asia Pacific (Singapore)** → copy the **connection string** (it ends with `?sslmode=require`).
   Supabase or Azure Database for PostgreSQL work the same way.
2. **Code on GitHub:** upload this folder to the repository (no `node_modules`, `dist` or `tests/e2e/output`).
3. **Render:** sign in at <https://render.com> with GitHub → **New → Blueprint** → choose the repository. Render
   reads `render.yaml` and asks for two values:
   - `DATABASE_URL` – the Neon connection string from step 1;
   - `ADMIN_DEFAULT_PIN` – your own 6–12 digit first-login PIN (not `1234`, no `123456`-style runs).
   Click **Apply**. The first build takes a few minutes; the address is `https://<service-name>.onrender.com`.
4. Open `https://<service-name>.onrender.com/#/admin`, sign in with that PIN and choose the Admin PIN you will keep.
5. Share `https://<service-name>.onrender.com` (e.g. as a QR code on the booth poster). Players register and play
   Solo on their phones; **Multiplayer Battle** shows a room code and QR that other phones scan to join.

Notes
- **Free plan** sleeps after 15 minutes without visitors (the next visit waits about a minute). For event days
  switch the service to **Starter** in Render → Settings → Instance type. Keep **one instance** (live races live
  in the server's memory; finished games are saved in PostgreSQL straight away).
- The server **refuses to start on Render** without `DATABASE_URL` (Render wipes its disk on every deploy) or with
  the default PIN – check the Render *Logs* tab if a deploy fails.
- **Data for later:** everything is in the PostgreSQL database and survives redeploys. Download it any time from
  Admin → **Exports & data** (Excel report / CSV) or Admin → **Feedback** (CSV / Excel); Neon also keeps its own
  history for restores. The booth's daily backup files are written to the server's temporary disk on Render, so
  download them if you want to keep them.
- Every push to the GitHub repository redeploys automatically (`autoDeploy` in `render.yaml`).
- Phones: every screen fits phone screens (checked at 360, 390 and 430 px wide and sideways – `npm run e2e:mobile`).
  **Head-to-Head** (two players on one screen) is hidden on phones and stays available on tablets and big screens.

## 1. Run it at the booth (Windows)

1. Install **Node.js LTS** (20.19 or newer) from <https://nodejs.org> (or through IT / Company Portal).
2. Copy this folder to the booth laptop. A local folder such as `C:\WordRush\` is better than OneDrive.
3. Double-click **`start-booth.cmd`**. The first run installs packages and builds the app (needs internet once).
   After that it starts in a few seconds, **opens the game in the browser by itself**, and runs without internet
   (phones only need the booth Wi-Fi). If Node.js isn't installed it also looks for a portable copy unzipped under
   `%TEMP%\pmxbuild`.
4. Open these in **Microsoft Edge or Google Chrome**:

| Screen | Address |
|---|---|
| Kiosk game (touchscreen) | `http://localhost:8090/#/` |
| TV display | `http://localhost:8090/#/display` |
| Admin (PIN) | `http://localhost:8090/#/admin` |
| Phones (Multiplayer Battle) | `http://<laptop address>:8090/#/join` – normally opened by scanning the QR on the lobby screen |

The server window prints the laptop's **network address** (e.g. `http://10.1.2.3:8090`). Put that address in
**Admin → Settings → Network address for the phone join QR code** (or `PUBLIC_BASE_URL` in `.env`) – phones can't
open "localhost". Phones must be on the same Wi-Fi as the laptop; if they can't connect, allow Node.js through the
Windows firewall (private networks) or ask IT.

> **Not the old quiz:** `PMX Digital Challenge\PLAY - PMX Digital Challenge.html` is the earlier quiz ("Match the
> Digital Solution", name only). It has no registration form and no multiplayer – always start the game with
> `start-booth.cmd` in this folder.
>
> Terminal instead of the .cmd file: `npm install`, `npm run build`, `npm start`.
> On PETRONAS laptops PowerShell may block `npm` – type **`npm.cmd`** instead (e.g. `npm.cmd start`).

**Playing** – **Tap to Begin** on the home page opens the registration card; **Start** begins a Solo Rush.
**Multiplayer Battle** opens a room for 2–4 phones; **Head-to-Head** shows two registration cards side by side on this
screen. Every screen outside a race has a **Home** button (registration, results, leaderboard, battle lobby, how-to) –
except the feedback questions, which have no Home / Back button – and Admin and the TV display have **Back to Home**.

**Booth feedback** – when a game ends (after the constellation reveal) and **before the result card**, each player
answers three one-tap questions: *Was the information shared at the booth relevant to your project or business needs?*
(Yes / No) · *Would you consider adopting or exploring any of the solutions showcased?* (Yes / No; on Yes, optional
chips for the solutions in Admin → Solutions & decoys) · *Did the booth help you better understand the available
digital solutions?* (1–5 stars: Not at all, A little, Somewhat, Yes, Very much). **See My Result** stays disabled until
all three are answered. The score is saved before the questions appear. Each player is asked **once per day** (full
name + project name or OPU, as on the leaderboard, Admin merges included); a replay that day goes straight to the
result card. Head-to-Head players answer one after the other on the kiosk; Battle players answer on their own phones.
If a phone loses the connection, the answer is kept on the phone and sent automatically (once) when it is back.

**Registration** (kiosk Solo, Head-to-Head and the phone join page all use the same form):

| Field | Rules |
|---|---|
| Full name | Required; 2–60 characters after trimming; letters (any language, accents included), spaces, apostrophes, hyphens and periods; "bin", "binti", "a/l" and "a/p" are fine. Numbers, other symbols and blocked words are refused. Error: *Please enter your full name.* |
| You are from | Two large toggles, **Project** and **Business** – nothing is pre-selected. Error: *Please select Project or Business.* |
| Project name (Project) | Slides in under the toggles. Required; 2–80 characters; letters, digits and common punctuation (e.g. "PFLNG 3", "GT&C (Phase 2)"); blocked words refused. Error: *Please enter your project name.* |
| OPU (Business) | Slides in under the toggles. A large touch-friendly picker that opens as a bottom sheet, grouped under headings: **Downstream** – MRCSB, PC MTBE, PCEPE, PCFKSB, PCGCo, PCMSB, PCOGD, PDB, PETCO, PLISB, PP(T)SB, PRPC Group · **Gas & Maritime** – MLNG, PGB GPU · **PE&T** – GPE, PDSB, PRSB · **Upstream** – MPM, PMA, SBA, SKA · then **Others**. Saved and shown in full (e.g. "Downstream - MRCSB"); editable in Admin → Settings. Error: *Please select your OPU.* |
| Consent | *I agree my name and project/OPU will be recorded for this event and shown on the leaderboard.* |

Switching between Project and Business clears the other field. **Start** stays disabled until the form is valid;
tapping it while disabled shows every problem inline under its field (red, with an icon – never a pop-up) and moves to
the first one. The server checks everything again, including the blocked-word list.

**Admin** – tap the faint **gear** (bottom-right of the home page), **press and hold the PMX logo for
2.5 seconds**, press **Ctrl + Shift + A**, or open `#/admin`. The first-login PIN is **`1234`** (`ADMIN_DEFAULT_PIN`).
It must be changed straight away to a 6–12 digit PIN (no repeated digits or runs like 123456) and never works again,
so 1234 can never be the event PIN. Five wrong PINs lock Admin for 5 minutes.

**Full screen** – the ⛶ button (top-right) or F11. Kiosk mode blocks pinch/double-tap zoom, long-press menus and
text selection. Edge kiosk mode (`msedge --kiosk http://localhost:8090/#/ --edge-kiosk-type=fullscreen`) also works.

## 2. How the game works (as built)

| Rule | Implementation |
|---|---|
| Round | The 6 solutions, one at a time, in random order. Each shows its clue and shuffled tiles: the answer words plus 2–3 decoys (Admin: min/max). |
| Correct tile | Placed into the answer; when the name is complete the star lights up, a chime plays and the next solution appears straight away. |
| Wrong tile | Shakes red with ✕ and adds **+1 s** (Admin setting). Nothing is lost. |
| Skip | Moves the solution to the end of the queue (its progress is cleared) and adds **+2 s**. Not available for the last one. |
| Timer | 30 s (Admin: 10–120 s). Penalties move the clock forward. Yellow; red with "Hurry!" and a tick each second in the last 5 s. |
| Hard Mode | Words of up to 4 letters (Admin: 2–6) become letter tiles – e.g. P·T·Q Online, Project A·I, P·D·S·B Services – plus one decoy letter each. |
| Finish | All 6 built = finishing time (incl. penalties). Otherwise the round ends when the clock runs out. |
| Ranking | More solved first; then faster time; then whoever got there first. Out-of-time games use **time used** = the moment their last solution was built (so 5 solved at 18.40 s beats 5 solved at 24.10 s). Times are shown to 0.01 s. |
| Titles | 6 = **NC Master**, 4–5 = **NC Explorer**, 0–3 = **NC Rookie**. |
| Boards | Fastest Today and All-Time show each player's **best** game, with a **Project / OPU** column. A player is **full name + project name** (any capitals/spacing, Admin merges applied) or **full name + OPU**. Multiplayer wins: battle and head-to-head wins per player. |
| Battle | 2–4 players; same order and tile shuffle for everyone; winner = rank 1 (needs at least one solution built). |

**The server is the source of truth for time.** A tap counts at the moment the server receives it, measured from the
server's GO time; devices only show it. Each device runs the same rules locally so feedback is instant, then the
server's state replaces the local one. A refresh, a dropped Wi-Fi or a closed phone never resets or pauses a game – the
page re-attaches with its saved token and continues; the server keeps timing. If a battle player disconnects, the
others continue and that player's game ends when their time runs out.

## 3. Event-day checklist

**Before doors open**
1. Start `start-booth.cmd` on the booth laptop; check the server window shows the network address.
2. Open the kiosk (`#/`), the TV display (`#/display`) and Admin (`#/admin`, sign in with your PIN).
3. Admin → **Settings**: set the network address for the join QR; check timer (30 s), penalties (1 s / 2 s), Hard Mode
   (off for most visitors), rehearsal mode, and the **OPU list**.
4. Admin → **Solutions & decoys**: confirm the names, clues and recap lines; *Preview a round* to see the tiles.
5. Rehearse: turn **Rehearsal mode on**, play a Solo game (once as Project, once as Business), a Battle with two phones
   and a Head-to-Head. Rehearsal games never reach the boards or the statistics.
6. Turn **Rehearsal mode off**, then Admin → **Exports & data → Delete rehearsal / test data** (re-enter the PIN).
7. Kiosk: tap ⛶ for full screen, set the volume, check sound works (🔊 toggle).

**During the event**
- Watch Admin → **Live races** for stuck lobbies (they close by themselves after 5 minutes idle; *Stop race* ends one).
- Remove a silly or invalid entry under **Results & players → Remove** (with a reason; it can be restored).
- **Leaderboards → Reset daily board** starts Today's board again (nothing is deleted; All-Time is kept).

**After the event**
- Under **Project names**, merge spellings that mean the same project (e.g. "Kasawari CCS" into "Kasawari") before
  reporting.
- Admin → **Exports & data → Excel report** (one sheet each for games, participants, feedback, project names, OPUs and
  solutions – every player row has *Full name, From, Project name, OPU*) or CSV per table. Daily backups are in
  `BACKUP_DIR` (default `%LOCALAPPDATA%\Nerv Centre Word Rush\backups` – the folder name is kept so existing data is
  found).

## 4. Admin

| Section | What it does |
|---|---|
| Dashboard | Players, games, completion rate, fastest and average times, stars-lit distribution, games by hour/day, mode split, solution solve rates and wrong taps, **Project vs Business**, **players by OPU** (every OPU in the list), **players by project name** (spellings grouped), feedback rate, average understanding and solution interest. Filter by day and mode. Every chart has a table view. |
| Feedback | The three booth questions: total responses and response rate (answers ÷ completed games), Q1 and Q2 Yes / No donuts, Q3 average stars and 1–5 distribution, players interested in each solution (highest first), breakdown by OPU and by project name. Filters: date range, game mode (Solo / Team), Project vs Business, OPU. Rehearsal answers are left out. CSV and Excel export of the filtered answers. |
| Live races | Open lobbies and races with each player's progress and connection; stop a stuck race. |
| Results & players | Every game (search by name, project or OPU; filter; show rehearsal games); remove/restore invalid entries; mark a game as test. Players view: best result, games, battle wins. |
| Leaderboards | Fastest today, All-time, Multiplayer wins (today / all-time); reset the daily board. |
| Solutions & decoys | Edit the 6 names, clues, recap lines and decoys; preview a round in normal and Hard Mode. |
| Settings | Timer, penalties, Hard Mode, decoys per round, global decoys, rehearsal mode, sound default, home page title and subtitle, How-to / idle / lobby timeouts, join-QR address, **OPU list** (one per line, in display order), blocked words. |
| Project names | Automatic case-insensitive grouping of typed project names; the merge tool (tick two or more groups → merge into one, optional display name), rename and unmerge. Merges apply to the boards, dashboard and exports. |
| Exports & data | Excel and CSV exports, backups (download / back up now), delete rehearsal data. |
| Audit log | Logins, PIN changes, settings and solution edits (old → new), removals, merges, board resets, exports, deletions. |

## 5. Development

```bash
npm install
npm run dev        # API + Socket.IO on :8090, Vite on http://localhost:5174 (proxied, hot reload)
npm test           # unit + integration tests (in-memory PostgreSQL, real Socket.IO clients)
npm run build      # type-check + production build → dist/client
npm run e2e        # end-to-end run in Edge/Chrome on a throw-away database (needs a build first)
npm run e2e:mobile # every screen at phone sizes (360 / 390 / 430 px and sideways) – screenshots in tests/e2e/output/mobile
npm run db:reset -- --yes   # delete the embedded database (re-created on the next start)
```

Configuration lives in `.env` (copy `.env.example`): port, `DATABASE_URL` (leave empty for the embedded PostgreSQL,
or point it at PostgreSQL / Supabase / Azure Database for PostgreSQL), `DATA_DIR`, `BACKUP_DIR`, `ADMIN_DEFAULT_PIN`,
optional HTTPS certificate, `PUBLIC_BASE_URL`.

## 6. Architecture

- **One Node.js process** (Fastify) serves the app, the REST API and **Socket.IO** (WebSocket with automatic HTTP
  long-polling fallback for networks that block WebSockets, automatic reconnection).
- **PostgreSQL** – embedded PGlite by default (no install; data in `%LOCALAPPDATA%`, never inside OneDrive), or a
  PostgreSQL server via `DATABASE_URL`. Schema migrations run at start-up.
- **Player data**: `full_name`, `affiliation_type` (`project` | `business`), `project_name` (nullable) and `opu`
  (nullable) on players and runs. Migration `002_affiliation` moved every existing `department` into `project_name`
  with type `project` (and department merges into project-name merges), so no earlier data is lost. The OPU list is
  stored in the settings table (`opus`).
- **Feedback** (`feedback` table, migration `004_feedback_questions`): `feedback_id` (made on the device, so a resend
  is never stored twice), `session_id` (the game), `player_id`, `team_id` (the Battle / Head-to-Head race), the
  player's name / Project or Business / project name / OPU, `q1_relevant`, `q2_would_explore`,
  `q2_interested_solutions` (solution ids), `q3_understanding_rating` (1–5), `game_mode` (`solo` | `team`),
  `submitted_at` (UTC) and `is_test`. A unique index allows one answer per player per Kuala Lumpur day. Answers from
  the earlier optional form (rating / interest / comment) are kept in `feedback_legacy` and in backups.
- **Race engine** (`server/game/engine.ts`) holds live races in memory and saves them on every solve, wrong tile,
  skip and end. Each run has a deadline timer (GO + limit − penalties). After a server restart, running races are
  picked up again (runs whose time ran out while the server was down end at once); open lobbies are closed.
- **Shared rules** (`shared/`): puzzle building (seeded shuffle – same seed = same round), the tap/skip reducer,
  ranking, titles, registration validation (`shared/validation.ts`), profanity filter, project-name grouping
  (`shared/affiliation.ts`).
- **Security**: Admin PIN hashed with scrypt, forced change of the default PIN, lockout, 12-hour sessions, audit log;
  every run and host screen has its own secret token (only hashes stored); server-side validation of every message
  (zod) and a flood guard; scores can't be changed from the browser because the server computes them.

## 7. Testing

- `npm test` – **53 unit and integration tests**: start-up checks for Render (database and PIN required), puzzle building (deterministic, decoys never equal an answer word,
  Hard Mode letters), the reducer (wrong tile, skip, last-skip, time-up by penalty, ranking, titles, 0.01 s),
  registration rules (full name incl. bin/binti/a/l/a/p, numbers/symbols-only, profanity; Project / Business; project
  name; OPU from the list; OPU headings; consent; exact messages), project-name grouping and merges, identity (name +
  project or OPU), the `002_affiliation` and `003_opu_entities` migrations on old data, PIN policy; then full games over Socket.IO: Solo with server
  timing and penalties, results and boards, best-per-player, server-side time-up, Battle (lobby, kick, full room, late
  join, host-only start, same puzzles, synchronised GO, disconnect, winner, wins board, refresh/re-attach, stolen
  token), Head-to-Head, server restart recovery, and Admin (PIN change/lockout, settings validation, OPU list editing,
  solutions, remove/restore, project merges, daily reset, feedback, rehearsal mode, dashboard, CSV/Excel, test-data
  removal, audit), and booth feedback (score saved before the questions, all three required, chips only with Yes,
  once per player per day incl. merges and the KL day change, Battle / Head-to-Head players separately, a resent
  answer stored once with its own time, dashboard numbers checked against SQL, filters, exports, migration `004`).
- `npm run e2e:mobile` – **305 phone checks**: Solo (home, registration, how-to, game, reveal, feedback, results,
  leaderboard) on 360×740, 390×844 and 430×932 screens, a Multiplayer Battle hosted and played on phones, every Admin
  section and the TV display on a 360 px phone, and a phone turned sideways – nothing wider than the screen,
  everything reachable by scrolling, tap targets ≥ 44 px (Admin ≥ 24 px), text ≥ 11 px, the clock and every tile on
  screen while playing. (Chromium with phone emulation; check once on a real iPhone and Android phone too.)
- `npm run e2e` – **333 browser checks**, playing everything in Edge: the registration form (nothing pre-selected,
  inline validation messages, slide-in field, switching clears the other field, OPU bottom sheet, colours, consent,
  server blocked-word check), both registration paths at 1920×1080, 1024×768 and 768×1024, Solo (wrong tile, skip,
  all six, reveal, feedback questions – colours, disabled button, chips, stars, double tap – results, leaderboard
  with Project / OPU, a same-day replay that skips the questions), feedback on phones at 390×844, 375×667 and 360×640
  (an answer given offline syncs once), refresh mid-game, time-up, Admin first login,
  solution edit, Hard Mode game, removing an entry, a 3-phone Battle with a kicked player and a dropped phone plus the
  TV display, Head-to-Head with simultaneous taps, dashboard charts, exports, project-name grouping and merge,
  rehearsal data, audit, and a scan of every screen for leftover "Nerv Centre" text – with layout checks (nothing cut
  off, no sideways scrolling, touch targets ≥ 56 px).

## 8. Folder structure

```
client/src/kiosk/      big-screen flow: home, registration, how-to, solo & head-to-head race, battle host, results
client/src/player/     phone flow for Multiplayer Battle (#/join)
client/src/display/    TV display (#/display)
client/src/admin/      staff area: dashboard, feedback, live races, results, boards, solutions, settings, project names, data, audit
client/src/components/ registration form + OPU picker, constellation, starfield, timer, puzzle board, countdown, reveal, boards, QR
client/src/lib/        Socket.IO + server clock, race / run hooks, sessions (refresh resume), sound, data stores
server/game/engine.ts  the race engine (timing, penalties, lobbies, battles, recovery)
server/realtime.ts     Socket.IO events
server/routes/         public and admin REST endpoints
server/services/       boards, analytics, auth, backups, exports
server/db/             PostgreSQL / PGlite, migrations, store (all SQL), seed
shared/                game rules, puzzles, validation, project names / OPUs, types, seed content
tests/                 unit, integration and e2e tests
```

## 9. Assumptions

- **New app, separate folder.** Word Rush needs a server (real-time multiplayer, server timing, central database), so it
  is a new project next to *PMX Digital Challenge* and *PMX Digital Mission Control*; both are unchanged. The folder
  and the default data folder keep the name "Nerv Centre Word Rush" so existing data is found; nothing a visitor sees
  says "Nerv Centre" (the NERVCENTRE logo stays).
- **OPU list**: 21 entities plus "Others" (22 choices). "PE&T GPE / PDSB / PRSB" are written "PE&T - GPE" etc. like the
  other groups, so they appear under a PE&T heading. "Others" has no extra text box. Migration `003_opu_entities`
  replaces the first default list (Upstream, Downstream, …) on booths where it was saved unchanged; a list edited in
  Admin is kept.
- **Start is "disabled" with `aria-disabled`**: it looks disabled and does nothing until the form is valid, but a tap
  on it still shows what is missing – otherwise a visitor who skipped a field would not know why nothing happens.
- **Blocked words in a project name** show the project-name message (*Please enter your project name.*); in a name,
  the name message.
- **OPU changes** apply to new registrations; games already played keep the OPU name they were played with.
- **Project-name labels**: the most-used spelling of a group (ties: more capitals); Admin can rename any group.
- **Penalties move the clock forward** (a wrong tile leaves 1 s less), and the finishing time includes them.
- **"Time used" for out-of-time games** is the time of the last solution built (see Ranking) – otherwise every
  out-of-time game would tie at 30 s.
- **Skip** clears the progress of that solution, and is not offered for the last unsolved one.
- **Hard Mode** adds one decoy letter per letter-word; word decoys are unchanged.
- **Battle winner** needs at least one solution built; a 0–0 battle has no winner. Head-to-Head wins also count on the
  Multiplayer wins board.
- **The six solutions are fixed slots** (the constellation has six stars): Admin edits them rather than adding or
  deleting solutions.
- **Feedback heading** reads "🎉 Great game! Your score is ready." (the brief's "Great flying!" was written for a
  flying game; change it in `shared/feedback.ts`). The questions are fixed; the solution chips come from Admin →
  Solutions & decoys. "Team" in the feedback data = Multiplayer Battle and Head-to-Head.
- **Once per day** is per real player; rehearsal answers are counted separately, so a staff member who rehearsed is
  still asked when they play for real. "Completed games" for the response rate are games played to the end (all six
  built or out of time).
- **An offline answer** keeps the time it was given (never before the game ended, never in the future), so it counts
  for the right day even when it syncs after midnight. Without a connection the phone shows the result card from the
  race it already has; *Rank today* follows once it is back online.
- **Rehearsal mode** saves games as test data instead of a separate database; they never reach boards or statistics,
  and Admin deletes them in one step (backup first).
- **How to Play** can be skipped with "I'm ready!" in Solo / Head-to-Head; in a Battle it runs for everyone together.
- **Inactivity:** results and leaderboard screens return to the home page after 30 s (registration gets twice as
  long because of typing). The feedback questions show no countdown; a kiosk left alone on them returns to the home
  page after three times the idle time (90 s by default) – the score is already saved. Phones never time out.
- **Privacy (PDPA):** only full name and project name or OPU are collected, with the consent text above; nothing else
  is stored about players (no email, staff number, grade or phone). Full PIN-protected exports and backups stay on the
  booth laptop.
