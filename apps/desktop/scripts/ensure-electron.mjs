/**
 * Electron 43+ no longer downloads its binary in a package postinstall.
 * electron-vite still requires path.txt + dist before spawn, so desktop
 * entry scripts call this helper. CI / plain `pnpm install` stays untouched.
 *
 * Skip with SKIP_ELECTRON_DOWNLOAD=1 when a binary must not be fetched.
 *
 * The binary is fetched from ELECTRON_MIRROR when set (npmmirror by default,
 * for networks without GitHub access). Override with `ELECTRON_MIRROR=...`
 * or empty it to use the upstream GitHub release endpoint.
 */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

if (process.env.SKIP_ELECTRON_DOWNLOAD === '1') {
	process.exit(0)
}

const ELECTRON_MIRROR = process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/'

const require = createRequire(import.meta.url)

let electronDir
try {
	electronDir = dirname(require.resolve('electron/package.json'))
} catch {
	console.error('[ensure-electron] electron package is not installed in @agent-gateway/desktop')
	process.exit(1)
}

const pathFile = join(electronDir, 'path.txt')
if (existsSync(pathFile)) {
	const relative = readFileSync(pathFile, 'utf8').trim()
	if (relative && existsSync(join(electronDir, 'dist', relative))) {
		process.exit(0)
	}
}

console.log('[ensure-electron] downloading Electron binary…')
const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
	stdio: 'inherit',
	env: { ...process.env, ELECTRON_MIRROR }
})
if (result.status !== 0) {
	console.error(
		'[ensure-electron] download failed. Check network / mirror, or run: pnpm --filter @agent-gateway/desktop exec node node_modules/electron/install.js'
	)
	process.exit(result.status ?? 1)
}
