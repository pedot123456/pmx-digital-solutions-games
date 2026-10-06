/**
 * PMX Digital Challenge – Word Rush: booth server.
 * Serves the kiosk app, the phones, the TV display, the admin area, the API and Socket.IO from one process.
 */
import os from 'node:os'
import { buildApp } from './app'
import { cloudProblems, loadConfig } from './config'
import { createStore } from './db/store'

const config = loadConfig()
const problems = cloudProblems(config)
if (problems.length) {
  for (const p of problems) console.error(`\n  ✖ ${p}`)
  console.error('\n  The server did not start. Fix the environment variables in the Render dashboard and redeploy.\n')
  process.exit(1)
}

const { store, migrations, seeded } = await createStore({ databaseUrl: config.databaseUrl, dataDir: config.dataDir })
// A join address set in .env wins over Admin → Settings (leave it empty to manage it in Admin).
if (config.publicBaseUrl) await store.setSettings({ public_base_url: config.publicBaseUrl })
const { app, services, recovered } = await buildApp({
  store,
  appVersion: config.appVersion,
  adminDefaultPin: config.adminDefaultPin,
  backupDir: config.backupDir,
  clientDist: config.clientDist,
  logger: { level: config.logLevel },
  https: config.https,
})

await app.listen({ port: config.port, host: config.host })
services.backups.start((msg, err) => app.log.error({ err }, msg))

const proto = config.https ? 'https' : 'http'
const lan = Object.values(os.networkInterfaces())
  .flat()
  .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
  .map((i) => `${proto}://${i.address}:${config.port}`)

console.log(`
  PMX Digital Challenge – Word Rush  v${config.appVersion}
  ──────────────────────────────────────────────
  Kiosk     ${proto}://localhost:${config.port}/#/
  Display   ${proto}://localhost:${config.port}/#/display
  Admin     ${proto}://localhost:${config.port}/#/admin
  Phones    ${config.publicBaseUrl ? `${config.publicBaseUrl.replace(/\/$/, '')}/#/join` : lan.length ? `${lan[0]}/#/join` : '(no network address found – phones cannot join)'}
  Network   ${lan.join('  ') || '(no network interface found)'}
  Database  ${config.databaseUrl ? 'PostgreSQL (DATABASE_URL)' : `embedded PostgreSQL at ${config.dataDir}`}
  Backups   ${config.backupDir} (daily)
  ${migrations.length ? `Migrations applied: ${migrations.join(', ')}` : 'Schema up to date'}${seeded.length ? `\n  Seeded: ${seeded.join(', ')}` : ''}${recovered.resumed || recovered.cancelled ? `\n  Recovered: ${recovered.resumed} race(s) resumed, ${recovered.cancelled} lobby(ies) closed` : ''}
  Press Ctrl+C to stop.
`)

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`\n${signal} received – shutting down…`)
  try {
    await app.close()
    await store.close()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
