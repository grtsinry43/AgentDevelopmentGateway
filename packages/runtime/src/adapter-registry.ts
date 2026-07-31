import {
  AdapterError,
  toRuntimeError,
  type AdapterId,
  type RuntimeAdapter,
  type RuntimeHostContext,
} from '@agent-gateway/core'
import type { RuntimeAdapterAvailability } from './types.js'

/** The provider-neutral registry. Agent routing terminates here, never in Server branches. */
export class AdapterRegistry {
  private readonly adapters = new Map<AdapterId, RuntimeAdapter>()

  constructor(adapters: Iterable<RuntimeAdapter> = []) {
    for (const adapter of adapters) this.register(adapter)
  }

  register(adapter: RuntimeAdapter): void {
    const adapterId = adapter.descriptor.id
    if (this.adapters.has(adapterId)) {
      throw new AdapterError({
        code: 'protocol',
        layer: 'transport',
        message: `Runtime adapter already registered: ${adapterId}`,
      })
    }
    this.adapters.set(adapterId, adapter)
  }

  get(adapterId: AdapterId): RuntimeAdapter {
    const adapter = this.adapters.get(adapterId)
    if (!adapter) {
      throw new AdapterError({
        code: 'not_implemented',
        layer: 'transport',
        nativeCode: 'gateway.adapter.not_registered',
        message: `Runtime adapter is not registered: ${adapterId}`,
      })
    }
    return adapter
  }

  list(): RuntimeAdapter[] {
    return [...this.adapters.values()]
  }

  async inspect(context: RuntimeHostContext): Promise<RuntimeAdapterAvailability[]> {
    return Promise.all(
      this.list().map(async (adapter): Promise<RuntimeAdapterAvailability> => {
        try {
          const installations = await adapter.detect(context)
          return {
            adapterId: adapter.descriptor.id,
            descriptor: adapter.descriptor,
            status: installations.length > 0 ? 'available' : 'unavailable',
            installations,
            ...(installations.length === 0
              ? {
                  error: {
                    code: 'connection' as const,
                    layer: 'transport' as const,
                    message: `${adapter.descriptor.displayName} was not found on host ${context.hostId}`,
                  },
                }
              : {}),
          }
        } catch (error) {
          return {
            adapterId: adapter.descriptor.id,
            descriptor: adapter.descriptor,
            status: 'unavailable',
            installations: [],
            error: { ...toRuntimeError(error, 'connection'), layer: 'transport' },
          }
        }
      }),
    )
  }
}
