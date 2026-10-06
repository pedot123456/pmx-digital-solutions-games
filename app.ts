import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { ZodError } from 'zod'
import type { Store } from './db/store'
import { registerAdminRoutes } from './routes/admin'
import { registerPublicRoutes } from './routes/public'
import { createServices, type Services } from './services'
import { HttpError } from './services/errors'

export interface AppOptions {
  store: Store
  appVersion: string
  adminDefaultPin: string
  /** Backup folder; omit to disable backups (tests). */
  backupDir?: string | null
  /** Built app (dist/client). Served when present. */
  clientDist?: string
  logger?: FastifyServerOptions['logger']
  https?: { key: Buffer; cert: Buffer } | null
  /** Test hook: the server clock. */
  clock?: () => number
}

/** HTTP API + Socket.IO + static app in one process. Used by `server/index.ts` and the tests. */
export async function buildApp(opts: AppOptions): Promise<{ app: FastifyInstance; services: Services; recovered: { resumed: number; cancelled: number } }> {
  const app = Fastify({
    logger: opts.logger ?? false,
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    ...(opts.https ? { https: opts.https } : {}),
  }) as unknown as FastifyInstance

  const services = createServices(opts.store, {
    appVersion: opts.appVersion,
    adminDefaultPin: opts.adminDefaultPin,
    backupDir: opts.backupDir ?? null,
    clock: opts.clock,
  })
  await services.auth.ensureAdmin()
  services.engine.onError = (msg, err) => app.log.error({ err }, msg)
  const recovered = await services.engine.recover()

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0]
      return reply.code(400).send({ error: 'invalid_request', message: first ? `${first.path.join('.') || 'value'}: ${first.message}` : 'Invalid request.', issues: err.issues.slice(0, 5) })
    }
    if (err instanceof HttpError) return reply.code(err.status).send(err.body)
    const status = (err as { statusCode?: number }).statusCode
    if (status && status < 500) {
      return reply.code(status).send({ error: (err as { code?: string }).code ?? 'bad_request', message: (err as Error).message })
    }
    req.log.error(err)
    return reply.code(500).send({ error: 'server_error', message: 'Something went wrong on the server.' })
  })

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('X-Frame-Options', 'SAMEORIGIN')
    return payload
  })

  registerPublicRoutes(app, services)
  registerAdminRoutes(app, services)

  const dist = opts.clientDist
  if (dist && existsSync(path.join(dist, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: '/',
      setHeaders(res, filePath) {
        const immutable = filePath.includes(`${path.sep}assets${path.sep}`)
        res.header('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache')
      },
    })
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.type('text/html').sendFile('index.html')
      return reply.code(404).send({ error: 'not_found' })
    })
  } else {
    app.get('/', async () => ({
      name: 'PMX Digital Challenge – Word Rush API',
      hint: 'Run "npm run build" to serve the app from this server, or "npm run dev" while developing.',
    }))
  }

  services.realtime.attach(app.server, services.engine, (msg, err) => app.log.error({ err }, msg))
  services.engine.start()

  // Open Socket.IO connections would keep the HTTP server from closing – drop them first.
  app.addHook('preClose', async () => {
    services.realtime.close()
  })
  app.addHook('onClose', async () => {
    services.engine.stop()
    services.backups.stop()
    await services.engine.flush()
  })
  return { app, services, recovered }
}
