import {
  AdapterError,
  type AdapterId,
  type RuntimeConnection,
  type RuntimeHostContext,
  type RuntimeInstallation,
} from '@agent-gateway/core'
import { AdapterRegistry } from './adapter-registry.js'

/** Resolves an installation explicitly and shares one in-flight/live connection per key. */
export class RuntimeConnectionManager {
  private readonly connections = new Map<string, Promise<RuntimeConnection>>()

  constructor(private readonly registry: AdapterRegistry) {}

  async connect(
    adapterId: AdapterId,
    context: RuntimeHostContext,
    installationPath?: string,
  ): Promise<RuntimeConnection> {
    const adapter = this.registry.get(adapterId)
    const installations = await adapter.detect(context)
    const installation = selectInstallation(adapterId, context.hostId, installations, installationPath)
    const key = connectionKey(adapterId, context.hostId, installation.path)
    const existing = this.connections.get(key)
    if (existing) return existing

    const connecting = adapter.connect({ context, installation })
    this.connections.set(key, connecting)
    try {
      return await connecting
    } catch (error) {
      if (this.connections.get(key) === connecting) this.connections.delete(key)
      throw error
    }
  }
}

function selectInstallation(
  adapterId: AdapterId,
  hostId: string,
  installations: RuntimeInstallation[],
  installationPath?: string,
): RuntimeInstallation {
  if (installationPath) {
    const selected = installations.find((installation) => installation.path === installationPath)
    if (selected) return selected
    throw connectionError(
      'gateway.installation.not_found',
      `Runtime ${adapterId} installation not found on ${hostId}: ${installationPath}`,
    )
  }
  if (installations.length === 1) return installations[0]!
  if (installations.length === 0) {
    throw connectionError(
      'gateway.installation.unavailable',
      `Runtime ${adapterId} is unavailable on host ${hostId}`,
    )
  }
  throw connectionError(
    'gateway.installation.selection_required',
    `Runtime ${adapterId} has multiple installations on ${hostId}; select one explicitly`,
  )
}

function connectionKey(adapterId: AdapterId, hostId: string, installationPath: string): string {
  return JSON.stringify([adapterId, hostId, installationPath])
}

function connectionError(nativeCode: string, message: string): AdapterError {
  return new AdapterError({ code: 'connection', layer: 'transport', nativeCode, message })
}
