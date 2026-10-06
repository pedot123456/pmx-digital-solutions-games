import type { Server as HttpServer } from 'node:http'
import type { Server as HttpsServer } from 'node:https'
import { Server, type Socket } from 'socket.io'
import { z } from 'zod'
import type { ClientToServer, Fail, ServerToClient } from '@shared/protocol'
import type { RaceState } from '@shared/types'
import type { Broadcaster, RaceEngine } from './game/engine'
import { GameError } from './services/errors'

type IO = Server<ClientToServer, ServerToClient>
type Sock = Socket<ClientToServer, ServerToClient>

const str = (max = 120) => z.string().min(1).max(max)
const player = z.object({
  full_name: z.string().max(200),
  affiliation_type: z.enum(['project', 'business']).nullable(),
  project_name: z.string().max(300).nullable().optional().transform((v) => v ?? null),
  opu: z.string().max(200).nullable().optional().transform((v) => v ?? null),
  consent: z.boolean(),
})
const SCHEMAS = {
  'solo:start': z.object({ player, kiosk_id: z.string().max(120) }),
  'h2h:start': z.object({ players: z.array(player).length(2), kiosk_id: z.string().max(120) }),
  'room:create': z.object({ kiosk_id: z.string().max(120) }),
  'room:join': z.object({ code: z.string().max(10), player, device_id: z.string().max(120) }),
  'room:leave': z.object({ race_id: str(), run_id: str(), token: str() }),
  'room:kick': z.object({ race_id: str(), host_token: str(), run_id: str() }),
  'room:start': z.object({ race_id: str(), host_token: str() }),
  'room:cancel': z.object({ race_id: str(), host_token: str() }),
  'race:watch': z.object({ race_id: str(), run_id: str().optional(), token: str().optional(), host_token: str().optional() }),
  'run:tap': z.object({ race_id: str(), run_id: str(), token: str(), puzzle: z.number().int().min(0).max(50), tile: str(20) }),
  'run:skip': z.object({ race_id: str(), run_id: str(), token: str(), puzzle: z.number().int().min(0).max(50) }),
} as const

function failFrom(err: unknown, log: (msg: string, err: unknown) => void): Fail {
  if (err instanceof GameError) {
    return { ok: false, error: err.code, message: err.message, ...(err.field ? { field: err.field } : {}), ...(err.errors ? { errors: err.errors } : {}) }
  }
  log('realtime handler failed', err)
  return { ok: false, error: 'server_error', message: 'Something went wrong – please try again.' }
}

/**
 * Socket.IO channel. Rooms: `race:<id>` (everyone in or watching a race) and `display`
 * (TV display + attract screens). Socket.IO reconnects by itself and falls back to HTTP
 * long-polling on networks that block WebSockets.
 */
export class Realtime implements Broadcaster {
  private io: IO | null = null
  private boardsTimer: ReturnType<typeof setTimeout> | null = null

  race(state: RaceState): void {
    this.io?.to(`race:${state.id}`).emit('race:state', state)
  }

  live(states: RaceState[]): void {
    this.io?.to('display').emit('live:changed', states)
  }

  boardsChanged(): void {
    if (this.boardsTimer) return
    this.boardsTimer = setTimeout(() => {
      this.boardsTimer = null
      this.io?.emit('boards:changed')
    }, 250)
    this.boardsTimer.unref?.()
  }

  settingsChanged(): void {
    this.io?.emit('settings:changed')
  }

  attach(server: HttpServer | HttpsServer, engine: RaceEngine, log: (msg: string, err: unknown) => void): void {
    const io: IO = new Server(server, {
      path: '/socket.io',
      serveClient: false,
      pingInterval: 10_000,
      pingTimeout: 8_000,
      maxHttpBufferSize: 64 * 1024,
    })
    this.io = io
    io.on('connection', (socket) => this.onConnection(socket, engine, log))
  }

  /** Disconnects every client (the HTTP server itself is closed by Fastify). */
  close(): void {
    if (this.boardsTimer) clearTimeout(this.boardsTimer)
    this.io?.disconnectSockets(true)
    this.io?.engine.close()
    this.io = null
  }

  private onConnection(socket: Sock, engine: RaceEngine, log: (msg: string, err: unknown) => void) {
    /** Races this socket is attached to, with the run ids / host handles it holds (released on disconnect). */
    const held = new Map<string, { runs: string[]; hosts: number }>()
    // Simple flood guard: at most 60 game messages per second per socket (two Head-to-Head players share one).
    let windowStart = Date.now()
    let count = 0
    const allow = () => {
      const now = Date.now()
      if (now - windowStart > 1000) {
        windowStart = now
        count = 0
      }
      return ++count <= 60
    }

    const hold = (raceId: string, runId: string | null, host: boolean) => {
      void socket.join(`race:${raceId}`)
      const h = held.get(raceId) ?? { runs: [], hosts: 0 }
      if (runId) h.runs.push(runId)
      if (host) h.hosts++
      held.set(raceId, h)
    }
    const releaseRace = (raceId: string) => {
      const h = held.get(raceId)
      if (h) {
        for (const runId of h.runs) engine.release(raceId, runId, false)
        for (let i = 0; i < h.hosts; i++) engine.release(raceId, null, true)
      }
      held.delete(raceId)
      void socket.leave(`race:${raceId}`)
    }
    /** Re-attaching to a race on the same socket must not double-count connections. */
    const watch = async (p: { race_id: string; run_id?: string; token?: string; host_token?: string }) => {
      const res = await engine.watch(p)
      // Only after a successful watch: drop this socket's previous hold on the race, then keep the new one.
      if (held.has(p.race_id)) releaseRace(p.race_id)
      hold(p.race_id, res.run_id, res.host)
      return res.race
    }

    const on = <K extends keyof typeof SCHEMAS>(event: K, fn: (p: z.infer<(typeof SCHEMAS)[K]>) => Promise<object>) => {
      ;(socket as unknown as { on: (e: string, h: (payload: unknown, cb: unknown) => void) => void }).on(event, (payload, cb) => {
        if (typeof cb !== 'function') return
        const reply = cb as (r: unknown) => void
        if (!allow()) return reply({ ok: false, error: 'rate_limited', message: 'Too fast – please slow down.' })
        const parsed = SCHEMAS[event].safeParse(payload)
        if (!parsed.success) return reply({ ok: false, error: 'invalid_request', message: 'Invalid request.' })
        fn(parsed.data as z.infer<(typeof SCHEMAS)[K]>)
          .then((res) => reply({ ok: true, ...res }))
          .catch((err) => reply(failFrom(err, log)))
      })
    }

    socket.on('time:sync', (cb) => {
      if (typeof cb === 'function') cb(Date.now())
    })

    socket.on('display:watch', (cb) => {
      void socket.join('display')
      if (typeof cb === 'function') cb({ ok: true, live: engine.liveStates() })
    })

    socket.on('race:unwatch', (p) => {
      if (p && typeof p.race_id === 'string') releaseRace(p.race_id)
    })

    on('solo:start', async (p) => {
      const res = await engine.startSolo(p.player, p.kiosk_id)
      const race = await watch({ race_id: res.race.id, run_id: res.run_id, token: res.token })
      return { ...res, race }
    })

    on('h2h:start', async (p) => {
      const res = await engine.startH2H(p.players, p.kiosk_id)
      const race = await watch({ race_id: res.race.id, host_token: res.host_token })
      return { ...res, race }
    })

    on('room:create', async (p) => {
      const res = await engine.createRoom(p.kiosk_id)
      const race = await watch({ race_id: res.race.id, host_token: res.host_token })
      return { ...res, race }
    })

    on('room:join', async (p) => {
      const res = await engine.joinRoom(p.code, p.player, p.device_id)
      const race = await watch({ race_id: res.race.id, run_id: res.run_id, token: res.token })
      return { ...res, race }
    })

    on('room:leave', async (p) => {
      await engine.leaveRoom(p.race_id, p.run_id, p.token)
      releaseRace(p.race_id)
      return {}
    })

    on('room:kick', async (p) => {
      await engine.kick(p.race_id, p.host_token, p.run_id)
      return {}
    })

    on('room:start', (p) => engine.startRoom(p.race_id, p.host_token))

    on('room:cancel', async (p) => {
      await engine.cancelRoom(p.race_id, p.host_token)
      return {}
    })

    on('race:watch', async (p) => ({ race: await watch(p) }))

    on('run:tap', (p) => engine.tap(p))
    on('run:skip', (p) => engine.skip(p))

    socket.on('disconnect', () => {
      for (const raceId of [...held.keys()]) releaseRace(raceId)
    })
  }
}
