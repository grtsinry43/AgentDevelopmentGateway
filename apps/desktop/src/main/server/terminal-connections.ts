import { gatewayServer } from './gateway.js'
import { TerminalConnectionRegistry } from './terminal-connection-registry.js'

export const terminalConnections = new TerminalConnectionRegistry(gatewayServer)
