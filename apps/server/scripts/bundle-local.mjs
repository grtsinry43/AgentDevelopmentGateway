// 本地生产 server bundle:esbuild 单文件 + 原生包 + Claude SDK,供桌面 DMG/生产包内嵌。
// 复用 package.mjs 的打包内核,但只产本地平台的 server.mjs + node_modules(不带 node 二进制)。
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(SERVER_ROOT, 'out', 'bundle')
const REQUIRED_NATIVE_PACKAGES = ['better-sqlite3', 'node-pty']
const OPTIONAL_NATIVE_PACKAGES = process.platform === 'darwin' ? ['fsevents'] : []
const EXTERNAL_NATIVE_PACKAGES = [...REQUIRED_NATIVE_PACKAGES, 'fsevents']
const BUNDLED_NATIVE_PACKAGES = [...REQUIRED_NATIVE_PACKAGES, ...OPTIONAL_NATIVE_PACKAGES]
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
const TARGET = `${process.platform}-${process.arch}`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(join(OUT, 'node_modules'), { recursive: true })

await build({
  entryPoints: [join(SERVER_ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(OUT, 'server.mjs'),
  external: [...EXTERNAL_NATIVE_PACKAGES, SDK_PACKAGE, 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __agentGatewayCreateRequire } from 'node:module'\nconst require = __agentGatewayCreateRequire(import.meta.url)"
  },
  logLevel: 'warning'
})

const requireFromServer = createRequire(join(SERVER_ROOT, 'package.json'))
for (const name of BUNDLED_NATIVE_PACKAGES) {
  const packageDirectory = realpathSync(dirname(requireFromServer.resolve(`${name}/package.json`)))
  cpSync(packageDirectory, join(OUT, 'node_modules', name), { recursive: true, dereference: true })
}

// SDK 是 adapter-claude 的依赖:scratch 里装一套含平台变体,再物化进 bundle 的 node_modules。
const requireFromAdapterClaude = createRequire(
  join(SERVER_ROOT, 'node_modules', '@agent-gateway', 'adapter-claude', 'package.json')
)
const sdkVersion = JSON.parse(
  await readFile(join(realpathSync(dirname(requireFromAdapterClaude.resolve(SDK_PACKAGE))), 'package.json'), 'utf8')
).version
const scratch = mkdtempSync(join(tmpdir(), 'agent-gateway-sdk-local-'))
try {
  writeFileSync(
    join(scratch, 'package.json'),
    `${JSON.stringify(
      {
        name: 'agent-gateway-server-sdk-staging',
        private: true,
        dependencies: {
          [SDK_PACKAGE]: sdkVersion,
          [`${SDK_PACKAGE}-${TARGET}`]: sdkVersion,
          '@anthropic-ai/sdk': '0.115.0',
          zod: '^4.4.3',
          '@modelcontextprotocol/sdk': '^1.29.0',
          ajv: '^8.0.0',
          'ajv-formats': '^3.0.0'
        }
      },
      null,
      2
    )}\n`
  )
  writeFileSync(join(scratch, '.npmrc'), 'node-linker=hoisted\n')
  const installed = spawnSyncPnpm(['--dir', scratch, 'install', '--lockfile=false'])
  if (installed.error) throw installed.error
  if (installed.status !== 0) throw new Error('pnpm install 失败')
  const scratchModules = join(scratch, 'node_modules')
  for (const entry of readdirSync(scratchModules)) {
    if (entry === '.pnpm' || entry === '.bin' || entry.startsWith('.')) continue
    cpSync(join(scratchModules, entry), join(OUT, 'node_modules', entry), {
      recursive: true,
      dereference: true
    })
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

await writeFileSync(
  join(OUT, 'install.json'),
  JSON.stringify({ package: '@agent-gateway/server', target: TARGET, sdkVersion, builtAt: new Date().toISOString() }, null, 2)
)

console.log(`✓ ${join(OUT, 'server.mjs')} (+ node_modules, target ${TARGET})`)

function spawnSyncPnpm(args) {
  if (process.env.npm_execpath) {
    return spawnSync(process.execPath, [process.env.npm_execpath, ...args], { stdio: 'inherit' })
  }
  return spawnSync(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
}
