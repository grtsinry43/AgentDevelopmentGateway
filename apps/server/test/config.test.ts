import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServerConfig } from '../src/config.js'

test('parses server configuration and rejects invalid ports', () => {
  const config = loadServerConfig({
    AGENT_GATEWAY_DATA_DIR: '/tmp/agent-gateway-test',
    PORT: '4321'
  })

  assert.equal(config.PORT, 4321)
  assert.equal(config.AGENT_GATEWAY_DATA_DIR, '/tmp/agent-gateway-test')
  assert.throws(() => loadServerConfig({ PORT: '0' }))
})
