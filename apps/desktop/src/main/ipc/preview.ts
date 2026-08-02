import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../contract/bridge.js'
import { resolveForSender } from '../server/gateway.js'
import { openPreviewTunnel } from '../remote/index.js'

/**
 * Web 预览入口:agent 报告它起的 localhost 端口,这里把它解析成客户端能访问的地址。
 * - 本地工程:端口就在本机,用 127.0.0.1 而非 localhost(macOS 上 localhost 可能解析成
 *   ::1,而 dev server 常只绑 127.0.0.1,会连接被拒白屏)。
 * - 远程工程:远端 localhost 客户端够不着,经 SSH 本地转发出一条隧道,返回
 *   http://127.0.0.1:<localPort>。白名单按解析后的 host+port 收紧。
 */
export function registerPreviewHandlers(): void {
  ipcMain.handle(IPC.previewOpen, async (event, rawPort: unknown) => {
    const port = z.number().int().positive().parse(rawPort)
    const resolved = await resolveForSender(event.sender)
    if (resolved.recent.hostType === 'ssh') {
      const hostProfileId = resolved.recent.hostProfileId
      if (!hostProfileId) throw new Error('远程工程缺少主机配置')
      const localPort = await openPreviewTunnel(hostProfileId, port)
      return { url: `http://127.0.0.1:${localPort}`, host: '127.0.0.1', port: localPort }
    }
    return { url: `http://127.0.0.1:${port}`, host: '127.0.0.1', port }
  })
}
