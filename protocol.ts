import type { SkipOutcome, TapOutcome } from './game'
import type { RaceState, RunProgress, RunStatus } from './types'
import type { Field, FieldErrors, PlayerInput } from './validation'

/**
 * Socket.IO events. Every client → server event takes an acknowledgement callback.
 * Tokens: each run has its own secret token (the device playing it); a race created by a kiosk
 * (Battle lobby, Head-to-Head) also has a host token. Only hashes are stored on the server.
 */

export type Fail = { ok: false; error: string; message: string; field?: Field; errors?: FieldErrors }
export type Ack<T> = ({ ok: true } & T) | Fail
export type Cb<T> = (res: Ack<T>) => void

export interface TapResult {
  outcome: TapOutcome | SkipOutcome
  progress: RunProgress
  status: RunStatus
}

export interface ClientToServer {
  'time:sync': (cb: (serverNow: number) => void) => void
  /** Solo Rush: creates the race and starts the 3-2-1 straight away. */
  'solo:start': (p: { player: PlayerInput; kiosk_id: string }, cb: Cb<{ race: RaceState; run_id: string; token: string }>) => void
  /** Head-to-Head on one screen: two runs in one race, both played on this kiosk. */
  'h2h:start': (
    p: { players: PlayerInput[]; kiosk_id: string },
    cb: Cb<{ race: RaceState; host_token: string; runs: { run_id: string; token: string }[] }>,
  ) => void
  /** Multiplayer Battle lobby on the big screen. */
  'room:create': (p: { kiosk_id: string }, cb: Cb<{ race: RaceState; host_token: string }>) => void
  'room:join': (p: { code: string; player: PlayerInput; device_id: string }, cb: Cb<{ race: RaceState; run_id: string; token: string }>) => void
  'room:leave': (p: { race_id: string; run_id: string; token: string }, cb: Cb<object>) => void
  'room:kick': (p: { race_id: string; host_token: string; run_id: string }, cb: Cb<object>) => void
  'room:start': (p: { race_id: string; host_token: string }, cb: Cb<{ race: RaceState }>) => void
  'room:cancel': (p: { race_id: string; host_token: string }, cb: Cb<object>) => void
  /** Subscribe to a race (after a refresh or reconnect too). A run token marks that player as connected. */
  'race:watch': (p: { race_id: string; run_id?: string; token?: string; host_token?: string }, cb: Cb<{ race: RaceState }>) => void
  'race:unwatch': (p: { race_id: string }) => void
  'run:tap': (p: { race_id: string; run_id: string; token: string; puzzle: number; tile: string }, cb: Cb<TapResult>) => void
  'run:skip': (p: { race_id: string; run_id: string; token: string; puzzle: number }, cb: Cb<TapResult>) => void
  /** TV display + attract screens: live races and board changes. */
  'display:watch': (cb: Cb<{ live: RaceState[] }>) => void
}

export interface ServerToClient {
  'race:state': (race: RaceState) => void
  'boards:changed': () => void
  'live:changed': (live: RaceState[]) => void
  'settings:changed': () => void
}
