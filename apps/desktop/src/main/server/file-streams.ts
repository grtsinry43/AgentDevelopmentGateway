import { gatewayServer } from './gateway.js'
import { FileStreamRegistry } from './file-stream-registry.js'

export const fileStreams = new FileStreamRegistry(gatewayServer)
