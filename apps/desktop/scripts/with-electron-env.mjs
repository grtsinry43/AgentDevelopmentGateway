#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const DEFAULT_ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

const [command, ...args] = process.argv.slice(2)
if (!command) {
  console.error('with-electron-env: missing command')
  process.exit(1)
}

const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR || DEFAULT_ELECTRON_MIRROR
}

const bin = resolveBin(command)
const child = spawn(process.execPath, [bin, ...args], {
  stdio: 'inherit',
  env
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

function resolveBin(commandName) {
  const require = createRequire(import.meta.url)
  const packageName = commandName === 'electron-builder' ? 'electron-builder' : commandName
  const packageJsonPath = require.resolve(`${packageName}/package.json`)
  const packageJson = require(packageJsonPath)
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[commandName]
  if (!bin) throw new Error(`Cannot resolve bin "${commandName}" from ${packageName}`)
  return join(dirname(packageJsonPath), bin)
}
