import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServerConfig, resolveConnectionToken } from '../src/config.js'

test('parses server configuration and rejects invalid ports', () => {
  const config = loadServerConfig({
    AGENT_GATEWAY_DATA_DIR: '/tmp/agent-gateway-test',
    PORT: '4321'
  })

  assert.equal(config.PORT, 4321)
  assert.equal(config.AGENT_GATEWAY_DATA_DIR, '/tmp/agent-gateway-test')
  assert.equal(config.AGENT_GATEWAY_HOST, '127.0.0.1')
  assert.equal(config.AGENT_GATEWAY_AUTH, 'none')
  assert.throws(() => loadServerConfig({ PORT: '-1' }))
  assert.throws(() => loadServerConfig({ PORT: '70000' }))
})

test('accepts port 0 as an ephemeral port for remote bootstrap', () => {
  const config = loadServerConfig({ PORT: '0' })
  assert.equal(config.PORT, 0)
})

test('resolves connection tokens with explicit token implying auth', () => {
  // 默认本地开发:不启用认证
  assert.equal(resolveConnectionToken(loadServerConfig({})), undefined)
  // AUTH=token 且未显式指定:生成随机 token
  const generated = resolveConnectionToken(loadServerConfig({ AGENT_GATEWAY_AUTH: 'token' }))
  assert.match(generated ?? '', /^[0-9a-f]{64}$/)
  // 显式 token 优先,且不需要同时设置 AUTH=token
  assert.equal(
    resolveConnectionToken(loadServerConfig({ AGENT_GATEWAY_CONNECTION_TOKEN: 'secret' })),
    'secret'
  )
})
