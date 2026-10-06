import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { cloudProblems, type ServerConfig } from '../../server/config'

const withDb = (databaseUrl: string) => ({ databaseUrl }) as ServerConfig

describe('start-up checks on a cloud host (Render)', () => {
  it('never block a booth laptop', () => {
    assert.deepEqual(cloudProblems(withDb(''), {}), [])
    assert.deepEqual(cloudProblems(withDb(''), { ADMIN_DEFAULT_PIN: '1234' }), [])
  })

  it('need a PostgreSQL DATABASE_URL (the disk is wiped on every deploy)', () => {
    const p = cloudProblems(withDb(''), { RENDER: 'true', ADMIN_DEFAULT_PIN: '482915' })
    assert.equal(p.length, 1)
    assert.match(p[0], /DATABASE_URL/)
    assert.deepEqual(cloudProblems(withDb(''), { RENDER: 'true', ADMIN_DEFAULT_PIN: '482915', ALLOW_EPHEMERAL_DB: '1' }), [], 'explicit opt-out for a throw-away demo')
  })

  it('need a first-login PIN of your own, never the default 1234', () => {
    for (const pin of [undefined, '1234', '123456', '111111', 'abcdef']) {
      const p = cloudProblems(withDb('postgres://db'), { RENDER: 'true', ADMIN_DEFAULT_PIN: pin })
      assert.equal(p.length, 1, String(pin))
      assert.match(p[0], /ADMIN_DEFAULT_PIN/)
    }
    assert.deepEqual(cloudProblems(withDb('postgres://db'), { RENDER: 'true', ADMIN_DEFAULT_PIN: '482915' }), [])
  })
})
