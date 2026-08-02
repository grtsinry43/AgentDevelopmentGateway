import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

const rendererRoot = resolve(import.meta.dirname, 'src/renderer')

export default defineConfig({
  main: {
    build: {
      // Shared is ESM-only. Bundle it into the CommonJS Electron main output instead of
      // leaving a runtime `require('@agent-gateway/shared')` that Node cannot resolve.
      externalizeDeps: { exclude: ['@agent-gateway/shared'] }
    }
  },
  preload: {
    build: {
      externalizeDeps: false
    }
  },
  renderer: {
    // `$lib` / `$contract` 必须同时声明在这里、tsconfig.web.json 的 paths 里。
    // 少一处就会出现「vite 能跑但 svelte-check 报错」。
    resolve: {
      alias: {
        $lib: resolve(rendererRoot, 'src/lib'),
        // main / preload / renderer 三方共享的 IPC 契约
        $contract: resolve(import.meta.dirname, 'src/contract')
      }
    },
    plugins: [tailwindcss(), svelte()],
    build: {
      rollupOptions: {
        // 一个窗口 = 一个入口。Launcher 与 Project 是主窗口;新建工程向导、
        // 主机管理、设置是 IDE 风格的辅助独立窗口,不做模态弹窗。
        input: {
          launcher: resolve(rendererRoot, 'launcher.html'),
          project: resolve(rendererRoot, 'project.html'),
          'new-project': resolve(rendererRoot, 'new-project.html'),
          'host-manager': resolve(rendererRoot, 'host-manager.html'),
          settings: resolve(rendererRoot, 'settings.html'),
          'open-project': resolve(rendererRoot, 'open-project.html'),
          about: resolve(rendererRoot, 'about.html'),
          export: resolve(rendererRoot, 'export.html'),
          capture: resolve(rendererRoot, 'capture.html')
        }
      }
    }
  }
})
