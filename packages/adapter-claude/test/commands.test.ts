import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listClaudeCommands } from '../src/commands.js'

test('lists project and user commands and skills with kind classification', () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-commands-'))
  // 项目命令
  mkdirSync(join(root, '.claude', 'commands'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'commands', 'review.md'),
    '---\ndescription: Review my changes\nargument-hint: [scope]\n---\nbody\n'
  )
  // 项目技能
  mkdirSync(join(root, '.claude', 'skills', 'code-reviewer'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'skills', 'code-reviewer', 'SKILL.md'),
    '---\nname: code-reviewer\ndescription: Review code for issues\n---\nbody\n'
  )

  const commands = listClaudeCommands(root)

  const review = commands.find((command) => command.name === 'review')
  assert.ok(review)
  assert.equal(review.kind, 'command')
  assert.equal(review.source, 'project')
  assert.equal(review.invoke, '/review')
  assert.equal(review.description, 'Review my changes')
  assert.equal(review.argumentHint, '[scope]')

  const skill = commands.find((command) => command.name === 'code-reviewer')
  assert.ok(skill)
  assert.equal(skill.kind, 'skill')
  assert.equal(skill.source, 'project')
  assert.equal(skill.invoke, '/code-reviewer')

  // 内置命令也列出
  const clear = commands.find((command) => command.name === 'clear')
  assert.ok(clear)
  assert.equal(clear.kind, 'command')
  assert.equal(clear.source, 'builtin')
  assert.equal(clear.invoke, '/clear')
})
