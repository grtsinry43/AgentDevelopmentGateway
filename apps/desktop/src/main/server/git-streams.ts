import { gatewayServer } from './gateway.js'
import { GitStreamRegistry } from './git-stream-registry.js'

export const gitStreams = new GitStreamRegistry(gatewayServer)
