import { buildServer } from './app.js'
import { loadServerConfig } from './config.js'

const { AGENT_GATEWAY_DATA_DIR: dataDirectory, PORT: port } = loadServerConfig(process.env)
const server = buildServer({ dataDirectory })

try {
  await server.listen({ host: '127.0.0.1', port })
} catch (error) {
  server.log.error(error)
  process.exitCode = 1
}
