import assert from 'node:assert/strict'
import test from 'node:test'
import { asToolCallId } from '@agent-gateway/core'
import {
  createClaudeProposedChangeSet,
  createFileChangeFromContents,
} from '../src/file-change.js'

test('renders a new Write as an all-addition file diff', async () => {
  const changeSet = await createClaudeProposedChangeSet(
    'Write',
    { file_path: '/workspace/new.ts', content: 'export const answer = 42\n' },
    asToolCallId('write-1'),
    '/workspace',
  )

  assert.equal(changeSet?.intent, 'proposed')
  assert.equal(changeSet?.files[0]?.kind, 'create')
  assert.equal(changeSet?.files[0]?.additions, 1)
  assert.deepEqual(changeSet?.files[0]?.hunks[0]?.lines, [
    { kind: 'addition', text: 'export const answer = 42', newLine: 1 },
  ])
})

test('builds a focused hunk from complete before and after contents', () => {
  const change = createFileChangeFromContents(
    'src/example.ts',
    ['one', 'two', 'three', 'four', 'five'].join('\n'),
    ['one', 'two', 'THREE', 'four', 'five'].join('\n'),
    '/workspace',
  )

  assert.equal(change.kind, 'modify')
  assert.equal(change.additions, 1)
  assert.equal(change.deletions, 1)
  assert.deepEqual(
    change.hunks[0]?.lines.map((line) => [line.kind, line.text]),
    [
      ['context', 'one'],
      ['context', 'two'],
      ['deletion', 'three'],
      ['addition', 'THREE'],
      ['context', 'four'],
      ['context', 'five'],
    ],
  )
})
