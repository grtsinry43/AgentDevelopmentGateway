import { resolve } from 'node:path'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'electron-vite'

const rendererRoot = resolve(import.meta.dirname, 'src/renderer')

export default defineConfig({
  main: {},
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
        // 两个窗口 = 两个入口。Launcher 与 Project 是独立 BrowserWindow,
        // 不是同一窗口内的路由。
        input: {
          launcher: resolve(rendererRoot, 'launcher.html'),
          project: resolve(rendererRoot, 'project.html')
        }
      }
    }
  }
})
