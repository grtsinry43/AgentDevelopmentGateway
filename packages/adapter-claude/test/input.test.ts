import assert from 'node:assert/strict'
import test from 'node:test'
import { mapSessionContext } from '../src/input.js'

test('maps application instruction fragments into gateway-context append text', () => {
  const mapped = mapSessionContext({
    snapshotId: 'snapshot',
    revision: 1,
    digest: 'digest',
    fragments: [
      {
        key: 'one',
        content: 'First rule',
        role: 'instruction',
        trust: 'application',
        source: { kind: 'session-rules', id: 'one' },
        digest: 'one-digest',
      },
      {
        key: 'two',
        content: 'Second rule',
        role: 'instruction',
        trust: 'application',
        source: { kind: 'project-rules', id: 'two' },
        digest: 'two-digest',
      },
    ],
  })
  assert.equal(
    mapped,
    '<gateway-context key="one">\nFirst rule\n</gateway-context>\n\n<gateway-context key="two">\nSecond rule\n</gateway-context>',
  )
})

test('returns undefined for empty or missing SessionContext', () => {
  assert.equal(mapSessionContext(undefined), undefined)
  assert.equal(
    mapSessionContext({ snapshotId: 'snapshot', revision: 1, digest: 'digest', fragments: [] }),
    undefined,
  )
})
