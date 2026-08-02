import { join } from 'node:path'
import { buildServer } from './app.js'
import { loadServerConfig, resolveConnectionToken } from './config.js'
import type { ServerIdentity } from './features/server/repository.js'
import {
  removeRuntimeFile,
  writeRuntimeFile,
  type ServerRuntimeInfo
} from './infrastructure/runtime-file.js'
import { SERVER_PROTOCOL_VERSION, SERVER_VERSION } from './protocol.js'

const config = loadServerConfig(process.env)
const connectionToken = resolveConnectionToken(config)

let identity: ServerIdentity | undefined
const server = buildServer({
  dataDirectory: config.AGENT_GATEWAY_DATA_DIR,
  ...(connectionToken ? { connectionToken } : {}),
  onServerIdentity: (resolved) => {
    identity = resolved
  }
})

try {
  await server.listen({ host: config.AGENT_GATEWAY_HOST, port: config.PORT })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}

const address = server.server.address()
if (address === null || typeof address === 'string' || !identity) {
  server.log.error('Server failed to report a listening address or identity')
  process.exit(1)
}

const runtimeFile =
  config.AGENT_GATEWAY_RUNTIME_FILE ?? join(config.AGENT_GATEWAY_DATA_DIR, 'runtime.json')
const runtime: ServerRuntimeInfo = {
  pid: process.pid,
  host: config.AGENT_GATEWAY_HOST,
  port: address.port,
  auth: connectionToken ? 'token' : 'none',
  ...(connectionToken ? { token: connectionToken } : {}),
  hostId: identity.id,
  version: SERVER_VERSION,
  protocolVersion: SERVER_PROTOCOL_VERSION,
  startedAt: Date.now()
}
writeRuntimeFile(runtimeFile, runtime)
// 哨兵行:bootstrap 脚本经 SSH stdout 解析这一行拿到端口、token 与身份,不轮询文件。
process.stdout.write(`AGENT_GATEWAY_LISTENING ${JSON.stringify(runtime)}\n`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    removeRuntimeFile(runtimeFile)
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1)
    )
  })
}
