import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyClaudeTool } from '../src/tool-kind.js'

test('classifies Claude built-in and MCP tools without adapter-id branching', () => {
  assert.equal(classifyClaudeTool('Bash'), 'terminal')
  assert.equal(classifyClaudeTool('Read'), 'file-read')
  assert.equal(classifyClaudeTool('Edit'), 'file-edit')
  assert.equal(classifyClaudeTool('Grep'), 'search')
  assert.equal(classifyClaudeTool('WebFetch'), 'web')
  assert.equal(classifyClaudeTool('Task'), 'subagent')
  assert.equal(classifyClaudeTool('TaskCreate'), 'task-control')
  assert.equal(classifyClaudeTool('mcp__example__lookup'), 'mcp')
  assert.equal(classifyClaudeTool('FutureTool'), 'generic')
})
