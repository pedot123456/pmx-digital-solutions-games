/**
 * Deletes the embedded database folder (it is re-created and re-seeded on the next start).
 * Usage: npm run db:reset -- --yes
 */
import { rmSync } from 'node:fs'
import { loadConfig } from '../config'

const config = loadConfig()
if (config.databaseUrl) {
  console.error('DATABASE_URL is set – reset that database with your PostgreSQL tools instead.')
  process.exit(1)
}
if (!process.argv.includes('--yes')) {
  console.log(`This deletes ALL game data in ${config.dataDir}.\nRun again with --yes to confirm:  npm run db:reset -- --yes`)
  process.exit(0)
}
rmSync(config.dataDir, { recursive: true, force: true })
console.log(`Deleted ${config.dataDir}. It will be re-created on the next start.`)
