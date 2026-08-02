import { homedir } from 'node:os'
import { join } from 'node:path'
import { app, nativeTheme } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'
import type { Platform, SystemInfo, WindowIdentity } from '../../contract/bridge.js'

const isMac = process.platform === 'darwin'

function toPlatform(value: NodeJS.Platform): Platform {
  return value === 'darwin' || value === 'win32' || value === 'linux' ? value : 'other'
}

/**
 * 共享的 BrowserWindow 选项。
 *
 * 窗口身份与 SystemInfo 都通过 `additionalArguments` 注入 —— renderer 首帧就需要它们
 * (决定渲染哪个壳、首帧主题、把路径折成 `~`)。走 IPC 的话 preload 里的 `await` 会
 * 晚于 renderer 脚本开始执行,导致读到空值或先渲染错误内容再纠正。
 *
 * 跨平台:macOS 有原生 vibrancy;Windows/Linux 上 `vibrancy` 无效,毛玻璃观感由
 * renderer 侧的半透明 + backdrop-blur 承担,底色不透明以免看到桌面(计划风险条目 2)。
 */
export function baseWindowOptions(identity: WindowIdentity): BrowserWindowConstructorOptions {
  const info: SystemInfo = {
    platform: toPlatform(process.platform),
    homeDir: homedir(),
    appVersion: app.getVersion(),
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors
  }

  return {
    show: false, // ready-to-show 才显示,避免白屏闪烁
    backgroundColor: isMac ? '#00000000' : '#1c1917',
    // 用 hidden 而非 hiddenInset:后者会让 macOS 自己加 inset 并覆盖 trafficLightPosition,
    // 造成红绿灯与标题不对齐、左右间距失衡。hidden 下坐标完全由我们控制。
    titleBarStyle: 'hidden',
    trafficLightPosition: isMac ? { x: 12, y: 12 } : undefined,
    ...(isMac ? { vibrancy: 'sidebar' as const, visualEffectState: 'active' as const } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Web 预览面板用 <webview> 嵌入 localhost 页面,以便拦截外部导航。
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js'),
      // preload 通过 process.argv 读取。JSON 序列化以便携带 projectKey。
      additionalArguments: [
        `--window-identity=${JSON.stringify(identity)}`,
        `--system-info=${JSON.stringify(info)}`
      ]
    }
  }
}

/** dev 下加载 vite server 的对应入口,prod 下加载打包出的 HTML。 */
export function entryUrl(
  name:
    | 'launcher'
    | 'project'
    | 'new-project'
    | 'host-manager'
    | 'settings'
    | 'open-project'
    | 'about'
    | 'export'
    | 'capture'
): { url?: string; file?: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) return { url: `${devServer}/${name}.html` }
  return { file: join(__dirname, `../renderer/${name}.html`) }
}
