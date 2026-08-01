import { gatewayServer } from './gateway.js'
import { SessionStreamRegistry } from './session-stream-registry.js'

export const sessionStreams = new SessionStreamRegistry(gatewayServer)
