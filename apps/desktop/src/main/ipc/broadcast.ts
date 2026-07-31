import { BrowserWindow } from 'electron'
import { PUSH_CHANNEL, type PushEvent } from '../../contract/bridge.js'

/**
 * 主进程 → 渲染进程的广播。
 *
 * 所有状态变化的**源头**都在主进程(存储、系统主题、窗口生命周期)。渲染进程不该
 * 靠轮询发现变化 —— 一是浪费,二是多窗口下必然出现窗口间状态不一致的时间窗。
 *
 * 全部走一个频道 + tagged union(见 contract/bridge.ts 的 PushEvent),
 * 这样 preload 只需一个 `ipcRenderer.on`,加事件不用动传输层。
 */
export function broadcast(event: PushEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    // 窗口可能正在销毁;webContents 也可能已经卸载(比如 reload 中途)
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    window.webContents.send(PUSH_CHANNEL, event)
  }
}

/** 广播给除指定 webContents 之外的所有窗口(操作发起方已经知道结果)。 */
export function broadcastExcept(senderId: number, event: PushEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue
    if (window.webContents.id === senderId) continue
    window.webContents.send(PUSH_CHANNEL, event)
  }
}
