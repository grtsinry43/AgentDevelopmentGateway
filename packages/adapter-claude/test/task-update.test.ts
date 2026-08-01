import assert from 'node:assert/strict'
import test from 'node:test'
import { mapClaudeTaskUpdates } from '../src/task-update.js'

test('maps TodoWrite authoritative output to a replacement checklist', () => {
  const updates = mapClaudeTaskUpdates(
    'TodoWrite',
    { todos: [] },
    {
      newTodos: [
        { content: 'Implement runtime', status: 'in_progress', activeForm: 'Implementing runtime' },
        { content: 'Run checks', status: 'pending', activeForm: 'Running checks' },
      ],
    },
  )

  assert.equal(updates[0]?.kind, 'replace')
  if (updates[0]?.kind !== 'replace') throw new Error('Expected replacement update')
  assert.deepEqual(
    updates[0].tasks.map(({ title, status, activeText }) => ({ title, status, activeText })),
    [
      {
        title: 'Implement runtime',
        status: 'in_progress',
        activeText: 'Implementing runtime',
      },
      { title: 'Run checks', status: 'pending', activeText: 'Running checks' },
    ],
  )
  assert.notEqual(updates[0].tasks[0]?.id, updates[0].tasks[1]?.id)
})

test('maps Claude task graph creation, enrichment and dependency patches', () => {
  assert.deepEqual(
    mapClaudeTaskUpdates(
      'TaskCreate',
      { subject: 'Build panel', description: 'Render task state', activeForm: 'Building panel' },
      { task: { id: '7', subject: 'Build panel' } },
    ),
    [
      {
        kind: 'upsert',
        task: {
          id: '7',
          title: 'Build panel',
          status: 'pending',
          description: 'Render task state',
          activeText: 'Building panel',
        },
      },
    ],
  )

  assert.deepEqual(
    mapClaudeTaskUpdates(
      'TaskUpdate',
      {
        taskId: '7',
        status: 'in_progress',
        owner: 'gateway',
        addBlocks: ['9'],
        addBlockedBy: ['2'],
      },
      { success: true, taskId: '7', updatedFields: ['status', 'owner'] },
    ),
    [
      {
        kind: 'patch',
        id: '7',
        changes: { owner: 'gateway', status: 'in_progress' },
        append: { blocks: ['9'], blockedBy: ['2'] },
      },
    ],
  )

  assert.deepEqual(
    mapClaudeTaskUpdates('TaskUpdate', { taskId: '7', status: 'deleted' }, {
      success: true,
      taskId: '7',
      updatedFields: ['status'],
    }),
    [{ kind: 'remove', id: '7' }],
  )
})

test('maps TaskList snapshots and TaskGet enrichment', () => {
  const list = mapClaudeTaskUpdates('TaskList', {}, {
    tasks: [
      {
        id: '7',
        subject: 'Build panel',
        status: 'in_progress',
        owner: 'gateway',
        blockedBy: ['2'],
      },
    ],
  })
  assert.deepEqual(list, [
    {
      kind: 'replace',
      tasks: [
        {
          id: '7',
          title: 'Build panel',
          status: 'in_progress',
          owner: 'gateway',
          blockedBy: ['2'],
        },
      ],
    },
  ])

  const get = mapClaudeTaskUpdates('TaskGet', { taskId: '7' }, {
    task: {
      id: '7',
      subject: 'Build panel',
      description: 'Render task state',
      status: 'in_progress',
      blocks: ['9'],
      blockedBy: ['2'],
    },
  })
  assert.equal(get[0]?.kind, 'upsert')
  if (get[0]?.kind !== 'upsert') throw new Error('Expected task upsert')
  assert.deepEqual(get[0].task.blocks, ['9'])
  assert.deepEqual(get[0].task.blockedBy, ['2'])
})

test('ignores failed TaskUpdate outputs', () => {
  assert.deepEqual(
    mapClaudeTaskUpdates('TaskUpdate', { taskId: '7', status: 'completed' }, {
      success: false,
      taskId: '7',
      updatedFields: [],
      error: 'not found',
    }),
    [],
  )
})
