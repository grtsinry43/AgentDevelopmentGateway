import assert from 'node:assert/strict'
import test from 'node:test'
import { AdapterRegistry } from '../src/adapter-registry.js'
import { FakeRuntimeAdapter } from './fakes/fake-adapter.js'

test('registers adapters once and reports host availability independently', async () => {
  const claude = new FakeRuntimeAdapter('claude-code')
  const codex = new FakeRuntimeAdapter('codex', [])
  const opencode = new FakeRuntimeAdapter('opencode')
  opencode.detectError = new Error('probe failed')
  const registry = new AdapterRegistry([claude, codex, opencode])

  const availability = await registry.inspect({ hostId: 'local' })

  assert.deepEqual(
    availability.map((entry) => [entry.adapterId, entry.status]),
    [
      ['claude-code', 'available'],
      ['codex', 'unavailable'],
      ['opencode', 'unavailable'],
    ],
  )
  assert.match(availability[1]?.error?.message ?? '', /not found/)
  assert.match(availability[2]?.error?.message ?? '', /probe failed/)
})

test('rejects duplicate and unknown adapter ids', () => {
  const registry = new AdapterRegistry([new FakeRuntimeAdapter('claude-code')])

  assert.throws(() => registry.register(new FakeRuntimeAdapter('claude-code')), /already registered/)
  assert.throws(() => registry.get('codex'), /not registered/)
})
