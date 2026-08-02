import {
  AdapterError,
  type AdapterId,
  type ProviderRuntimeConfig,
  type RuntimeConnection,
  type RuntimeHostContext,
  type RuntimeInstallation,
} from '@agent-gateway/core'
import { AdapterRegistry } from './adapter-registry.js'

interface ManagedConnection {
  connection: RuntimeConnection
  providerConfig?: ProviderRuntimeConfig
  /** Sessions currently bound to this connection; only idle connections may be recycled. */
  activeSessions: number
}

/**
 * Resolves an installation explicitly and shares one in-flight/live connection per key.
 *
 * The connection key includes a fingerprint of the resolved provider config, so a different
 * profile (different base URL / key) gets its own runtime connection instead of silently
 * reusing one spawned with different credentials — connection-level runtimes (Codex
 * app-server / OpenCode serve) read their provider config at process startup and cannot be
 * re-configured in place. When a new config is requested for the same base and the previous
 * connection has no sessions, it is closed via the adapter's `closeConnection`.
 */
export class RuntimeConnectionManager {
  private readonly connections = new Map<string, Promise<ManagedConnection>>()

  constructor(private readonly registry: AdapterRegistry) {}

  async connect(
    adapterId: AdapterId,
    context: RuntimeHostContext,
    installationPath?: string,
    providerConfig?: ProviderRuntimeConfig,
  ): Promise<RuntimeConnection> {
    const adapter = this.registry.get(adapterId)
    const installations = await adapter.detect(context)
    const installation = selectInstallation(adapterId, context.hostId, installations, installationPath)
    const key = connectionKey(adapterId, context.hostId, installation.path, providerConfig)
    const existing = this.connections.get(key)
    if (existing) return (await existing).connection

    // A different provider config for the same base supersedes any idle connection that was
    // spawned with a different config (e.g. the initial no-profile model-probe connection).
    // Only awaited when a config is present, so the unconfigured path stays synchronous with
    // respect to the map write below (concurrent listModels dedup relies on it).
    if (providerConfig) {
      await this.recycleSuperseded(adapterId, context.hostId, installation.path, providerConfig)
    }

    const connecting = adapter
      .connect({ context, installation, ...(providerConfig ? { providerConfig } : {}) })
      .then((connection) => ({ connection, providerConfig, activeSessions: 0 }))
    this.connections.set(key, connecting)
    try {
      return (await connecting).connection
    } catch (error) {
      if (this.connections.get(key) === connecting) this.connections.delete(key)
      throw error
    }
  }

  registerSession(connectionId: string): void {
    for (const managed of this.connections.values()) {
      void managed.then((entry) => {
        if (entry.connection.id === connectionId) entry.activeSessions += 1
      })
    }
  }

  unregisterSession(connectionId: string): void {
    for (const managed of this.connections.values()) {
      void managed.then((entry) => {
        if (entry.connection.id === connectionId && entry.activeSessions > 0) {
          entry.activeSessions -= 1
        }
      })
    }
  }

  private async recycleSuperseded(
    adapterId: AdapterId,
    hostId: string,
    installationPath: string,
    providerConfig?: ProviderRuntimeConfig,
  ): Promise<void> {
    if (!providerConfig) return
    const adapter = this.registry.get(adapterId)
    if (!adapter.closeConnection) return
    const requestedKey = connectionKey(adapterId, hostId, installationPath, providerConfig)
    for (const [key, managedPromise] of [...this.connections]) {
      const entry = await managedPromise
      if (key === requestedKey || entry.activeSessions > 0) continue
      // Only recycle connections on the same base (adapter/host/install) with a different config.
      if (connectionKey(adapterId, hostId, installationPath, entry.providerConfig) !== key) continue
      this.connections.delete(key)
      await adapter.closeConnection(entry.connection).catch(() => undefined)
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

function connectionKey(
  adapterId: AdapterId,
  hostId: string,
  installationPath: string,
  providerConfig?: ProviderRuntimeConfig,
): string {
  return JSON.stringify([adapterId, hostId, installationPath, providerConfig ?? null])
}

function connectionError(nativeCode: string, message: string): AdapterError {
  return new AdapterError({ code: 'connection', layer: 'transport', nativeCode, message })
}
