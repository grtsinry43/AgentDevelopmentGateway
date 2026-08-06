#!/usr/bin/env node
/**
 * 把 @agent-gateway/server 打成自包含 tarball,供远程主机下载安装:
 *
 *   agent-gateway-server-<version>-<os>-<arch>/
 *     server.js          esbuild 单文件 bundle(workspace 包与纯 JS 依赖全部内联)
 *     node_modules/      仅原生包 better-sqlite3 / node-pty(随包携带全平台 prebuilds)
 *     node/              目标平台的官方 Node 运行时(nodejs.org 下载并校验 sha256)
 *     bin/start.sh       用内置 Node 启动 server.js
 *     install.json       版本/协议/平台清单,远程 bootstrap 的幂等判断依据
 *
 * 产物: out/package/agent-gateway-server-<version>-<os>-<arch>.tar.gz (+ .sha256) 与 manifest.json。
 *
 * 交叉说明:两个原生包的 npm 包内自带全平台 prebuilds,因此本机(macOS)即可产出
 * linux-x64/arm64 产物,无需容器或 CI。musl 不支持(node-pty 没有 musl prebuild)。
 *
 * 用法: node scripts/package.mjs [--target linux-x64[,linux-arm64,...]] [--node-version 22.23.2]
 *        [--version 0.0.0] [--out out/package] [--keep-staging]
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { build as esbuild } from 'esbuild'

const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SUPPORTED_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']
const REQUIRED_NATIVE_PACKAGES = ['better-sqlite3', 'node-pty']
const OPTIONAL_NATIVE_PACKAGES = ['fsevents']
const NATIVE_PACKAGES = [...REQUIRED_NATIVE_PACKAGES, ...OPTIONAL_NATIVE_PACKAGES]
const EXTERNAL_NATIVE_PACKAGES = NATIVE_PACKAGES
/**
 * claude-agent-sdk 不能内联:它运行时用 createRequire 解析按平台的可选依赖
 * @anthropic-ai/claude-agent-sdk-<os>-<arch>(原生 CLI 二进制)与 ajv 等未打包的
 * 动态依赖。必须在每个目标平台 staging 里 npm 重装,见 stageSdkForTarget。
 */
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk'
/** 固定运行时版本;可用 --node-version 覆盖。升级前先确认 nodejs.org 上存在。 */
const DEFAULT_NODE_VERSION = '22.23.2'

const args = parseArgs(process.argv.slice(2))
const targets = (args.target ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)
for (const target of targets) {
  if (!SUPPORTED_TARGETS.includes(target)) {
    fail(`不支持的目标 ${target};可选: ${SUPPORTED_TARGETS.join(', ')}(musl 暂不支持)`)
  }
}
const nodeVersion = args['node-version'] ?? DEFAULT_NODE_VERSION
const outRoot = resolve(SERVER_ROOT, args.out ?? 'out/package')
const serverPackage = JSON.parse(readFileSync(join(SERVER_ROOT, 'package.json'), 'utf8'))
const version = args.version ?? serverPackage.version
const protocolVersion = readProtocolVersion()

console.log(`打包 @agent-gateway/server@${version} (protocol ${protocolVersion}) -> ${targets.join(', ')}`)

// 1. esbuild 单文件 bundle。原生包与 ws 的可选原生加速模块保持 external。
const sharedStaging = mkdtempSync(join(tmpdir(), 'agent-gateway-package-'))
if (!args['keep-staging']) process.on('exit', () => rmSync(sharedStaging, { recursive: true, force: true }))
mkdirSync(join(sharedStaging, 'node_modules'), { recursive: true })
await esbuild({
  entryPoints: [join(SERVER_ROOT, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(sharedStaging, 'server.js'),
  external: [...EXTERNAL_NATIVE_PACKAGES, SDK_PACKAGE, 'bufferutil', 'utf-8-validate'],
  banner: {
    js: "import { createRequire as __agentGatewayCreateRequire } from 'node:module'\nconst require = __agentGatewayCreateRequire(import.meta.url)"
  },
  logLevel: 'warning'
})

// 2. 原样复制原生包(含全平台 prebuilds),并校验每个目标平台的 prebuild 确实存在。
const requireFromServer = createRequire(join(SERVER_ROOT, 'package.json'))
for (const name of NATIVE_PACKAGES) {
  const resolvedPackage = tryResolvePackage(requireFromServer, name)
  if (!resolvedPackage) {
    if (OPTIONAL_NATIVE_PACKAGES.includes(name)) continue
    fail(`${name} 未安装;请先运行 pnpm install`)
  }
  const packageDirectory = realpathSync(dirname(resolvedPackage))
  cpSync(packageDirectory, join(sharedStaging, 'node_modules', name), {
    recursive: true,
    dereference: true
  })
  for (const target of targets) {
    assertNativePrebuild(name, join(sharedStaging, 'node_modules', name), target)
  }
}
// SDK 版本以仓库实际解析到的为准(与 adapter 依赖对齐)。
// SDK 是 adapter-claude 的依赖,不是 server 的直接依赖,从 adapter 的上下文解析。
const requireFromAdapterClaude = createRequire(
  join(SERVER_ROOT, 'node_modules', '@agent-gateway', 'adapter-claude', 'package.json')
)
const sdkVersion = JSON.parse(
  readFileSync(
    join(realpathSync(dirname(requireFromAdapterClaude.resolve(SDK_PACKAGE))), 'package.json'),
    'utf8'
  )
).version

// 3. 每个目标平台:组装目录 + Node 运行时 + install.json + tarball + sha256。
const artifacts = []
for (const target of targets) {
  const directoryName = `agent-gateway-server-${version}-${target}`
  const targetRoot = join(outRoot, '.staging', directoryName)
  rmSync(targetRoot, { recursive: true, force: true })
  mkdirSync(dirname(targetRoot), { recursive: true })
  cpSync(sharedStaging, targetRoot, { recursive: true })

  // 按目标平台重装 claude-agent-sdk(含匹配的 CLI 二进制可选依赖与 ajv 等动态依赖)。
  // 必须先于 install.json 写入;npm 需要能访问 registry。
  await stageSdkForTarget(targetRoot, target, sdkVersion)

  await installNodeRuntime(targetRoot, target, nodeVersion)
  writeFileSync(
    join(targetRoot, 'install.json'),
    `${JSON.stringify(
      {
        name: serverPackage.name,
        version,
        protocolVersion,
        os: target.split('-')[0],
        arch: target.split('-')[1],
        node: nodeVersion,
        builtAt: new Date().toISOString()
      },
      null,
      2
    )}\n`
  )
  mkdirSync(join(targetRoot, 'bin'), { recursive: true })
  writeFileSync(
    join(targetRoot, 'bin', 'start.sh'),
    '#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec "$ROOT/node/bin/node" "$ROOT/server.js" "$@"\n',
    { mode: 0o755 }
  )
  chmodSync(join(targetRoot, 'node', 'bin', 'node'), 0o755)

  mkdirSync(outRoot, { recursive: true })
  const tarball = `${directoryName}.tar.gz`
  run('tar', ['-czf', join(outRoot, tarball), '-C', dirname(targetRoot), directoryName])
  const sha256 = await hashFile(join(outRoot, tarball))
  writeFileSync(join(outRoot, `${tarball}.sha256`), `${sha256}  ${tarball}\n`)
  rmSync(targetRoot, { recursive: true, force: true })
  artifacts.push({ target, file: tarball, sha256, bytes: statSync(join(outRoot, tarball)).size })
  console.log(`  ✓ ${tarball} (${(statSync(join(outRoot, tarball)).size / 1_048_576).toFixed(1)} MB)`)
}

// 多次分批打包时按 target 合并 manifest,避免后一次运行覆盖前一次的产物记录。
const manifestPath = join(outRoot, 'manifest.json')
const existing = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : undefined
const merged = new Map(
  (existing?.version === version && Array.isArray(existing?.artifacts)
    ? existing.artifacts
    : []
  ).map((artifact) => [artifact.target, artifact])
)
for (const artifact of artifacts) merged.set(artifact.target, artifact)
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      version,
      protocolVersion,
      node: nodeVersion,
      generatedAt: new Date().toISOString(),
      artifacts: [...merged.values()]
    },
    null,
    2
  )}\n`
)
console.log(`完成: ${outRoot}`)

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) fail(`无法识别的参数: ${arg}`)
    const key = arg.slice(2)
    if (key === 'keep-staging') {
      parsed[key] = true
    } else {
      index += 1
      if (index >= argv.length) fail(`参数 --${key} 缺少值`)
      parsed[key] = argv[index]
    }
  }
  return parsed
}

function readProtocolVersion() {
  const compiled = readFileSync(join(SERVER_ROOT, 'dist/protocol.js'), 'utf8')
  const match = compiled.match(/SERVER_PROTOCOL_VERSION = (\d+)/)
  if (!match) fail('无法从 dist/protocol.js 读取 SERVER_PROTOCOL_VERSION,请先运行 pnpm build')
  return Number(match[1])
}

function assertNativePrebuild(name, packageDirectory, target) {
  if (name === 'fsevents') {
    // fsevents 是 macOS 专用单流 watcher,只随 darwin 目标打包;
    // linux 目标里的 fsevents 是无害死代码(platform 守卫,永不 import)。
    if (target !== 'darwin-arm64' && target !== 'darwin-x64') return
    if (!existsSync(join(packageDirectory, 'fsevents.node'))) {
      fail(`${name} 缺少 ${target} 的 prebuild: ${join(packageDirectory, 'fsevents.node')}`)
    }
    return
  }
  const candidates =
    name === 'better-sqlite3'
      ? [join(packageDirectory, 'prebuilds', `${target}.node`)]
      : [join(packageDirectory, 'prebuilds', target, 'pty.node')]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) fail(`${name} 缺少 ${target} 的 prebuild: ${candidate}`)
  }
}

/**
 * 用 pnpm 按目标平台安装 claude-agent-sdk 及其运行依赖,产出正确的平台 CLI 二进制。
 *
 * SDK 的 CLI 二进制是按平台的 optionalDependency
 * (@anthropic-ai/claude-agent-sdk-<os>-<arch>),且运行时还会动态 require 未打包的
 * ajv 等(来自 peer @modelcontextprotocol/sdk 的传递依赖)。pnpm 不会自动给当前平台
 * 之外的 optional 装包,所以在临时目录显式声明:SDK + 目标平台包 + peers + ajv,
 * node-linker=hoisted 保证 ajv 落在顶层(node_modules/ajv),SDK 的 createRequire
 * 才能从自身位置解析到。装完把整棵依赖树拷进产物 node_modules。
 */
async function stageSdkForTarget(targetRoot, target, version) {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-gateway-sdk-'))
  try {
    writeFileSync(
      join(scratch, 'package.json'),
      `${JSON.stringify(
        {
          name: 'agent-gateway-server-sdk-staging',
          private: true,
          dependencies: {
            [SDK_PACKAGE]: version,
            [`${SDK_PACKAGE}-${target}`]: version,
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
    run('pnpm', ['--dir', scratch, 'install', '--lockfile=false'], { quiet: true })
    const scratchModules = join(scratch, 'node_modules')
    if (!existsSync(scratchModules)) fail(`pnpm 未能安装 ${SDK_PACKAGE}@${version}`)
    for (const entry of readdirSync(scratchModules)) {
      // hoisted 布局下 .pnpm 是虚拟 store 的冗余副本,跳过;顶层条目是到 .pnpm 的符号链接。
      // dereference:true 物化符号链接,避免产物引用临时 staging 目录。
      if (entry === '.pnpm' || entry === '.bin' || entry.startsWith('.')) continue
      cpSync(join(scratchModules, entry), join(targetRoot, 'node_modules', entry), {
        recursive: true,
        dereference: true
      })
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function installNodeRuntime(targetRoot, target, version) {
  const cacheDirectory = join(outRoot, '.node-runtime-cache')
  mkdirSync(cacheDirectory, { recursive: true })
  const archiveName = `node-v${version}-${target}.tar.gz`
  const archivePath = join(cacheDirectory, archiveName)
  if (!existsSync(archivePath)) {
    const url = `https://nodejs.org/dist/v${version}/${archiveName}`
    console.log(`  下载 ${url}`)
    const response = await fetch(url)
    if (!response.ok || !response.body) fail(`Node 运行时下载失败: HTTP ${response.status} (${url})`)
    await pipeline(response.body, createWriteStream(archivePath))
  }
  const checksums = await (
    await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)
  ).text()
  const expected = checksums
    .split('\n')
    .find((line) => line.trim().endsWith(archiveName))
    ?.split(/\s+/)[0]
  if (!expected) fail(`SHASUMS256.txt 中找不到 ${archiveName}`)
  const actual = await hashFile(archivePath)
  if (actual !== expected) {
    rmSync(archivePath, { force: true })
    fail(`Node 运行时 sha256 校验失败: ${archiveName}`)
  }
  const extraction = mkdtempSync(join(tmpdir(), 'agent-gateway-node-'))
  run('tar', ['-xzf', archivePath, '-C', extraction])
  mkdirSync(join(targetRoot, 'node', 'bin'), { recursive: true })
  cpSync(join(extraction, `node-v${version}-${target}`, 'bin', 'node'), join(targetRoot, 'node', 'bin', 'node'))
  cpSync(join(extraction, `node-v${version}-${target}`, 'LICENSE'), join(targetRoot, 'node', 'LICENSE'))
  rmSync(extraction, { recursive: true, force: true })
}

async function hashFile(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function run(command, args, options = {}) {
  const invocation = commandInvocation(command, args)
  // COPYFILE_DISABLE:macOS 的 bsdtar 会把 xattr 写成扩展头,GNU tar 解包时刷警告。
  const result = spawnSync(invocation.command, invocation.args, {
    stdio: options.quiet ? 'pipe' : 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
    shell: invocation.shell
  })
  if (result.error) fail(`命令启动失败: ${command} ${args.join(' ')}\n${result.error.message}`)
  if (result.status !== 0) {
    if (options.quiet) {
      const tail = (result.stderr?.toString() ?? result.stdout?.toString() ?? '')
        .trim()
        .split('\n')
        .slice(-5)
        .join('\n')
      fail(`命令失败: ${command} ${args.join(' ')}\n${tail}`)
    }
    fail(`命令失败: ${command} ${args.join(' ')}`)
  }
}

function commandInvocation(command, args) {
  if (command === 'pnpm' && process.env.npm_execpath) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args], shell: false }
  }
  return {
    command: process.platform === 'win32' && command === 'pnpm' ? 'pnpm.cmd' : command,
    args,
    shell: process.platform === 'win32' && command === 'pnpm'
  }
}

function tryResolvePackage(requireFrom, name) {
  try {
    return requireFrom.resolve(`${name}/package.json`)
  } catch {
    return undefined
  }
}

function fail(message) {
  console.error(`package: ${message}`)
  process.exit(1)
}
