/**
 * 会话导出。
 *  - 点导出 → 打开「导出对话框」窗口(左侧实时预览 + 右侧选格式);
 *  - 确认后:HTML 用对话框生成的自包含文档直接保存;PNG/PDF 在一个**后台隐藏的
 *    offscreen 窗口**里用真实组件渲染,再 capturePage / printToPDF —— 不会出现
 *    挡住保存对话框的超高窗口。
 */
import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog, ipcMain, screen } from 'electron'
import type { ExportConversationPayload, ExportFormat } from '../../contract/bridge.js'
import { IPC } from '../../contract/bridge.js'
import { baseWindowOptions, entryUrl } from '../windows/chrome.js'

const EXPORT_WIDTH = 880
/** 捕获窗口高度封顶(超长对话导出前 MAX_CAPTURE_HEIGHT px,避免超高窗口)。 */
const MAX_CAPTURE_HEIGHT = 6000

let pendingPayload: ExportConversationPayload | undefined
let resolveRenderHeight: ((height: number) => void) | undefined

/** 导出对话框窗口(单例)。 */
let dialogWindow: BrowserWindow | null = null

export function registerExportIpc(): void {
  ipcMain.handle(IPC.exportConversation, async (_event, rawPayload: unknown) => {
    pendingPayload = sanitizePayload(rawPayload)
    await openExportDialog()
  })

  ipcMain.handle(IPC.exportCommit, async (_event, rawFormat: unknown) => {
    if (rawFormat === 'pdf') await capturePdf()
    else await capturePng()
  })

  ipcMain.handle(IPC.exportGetData, () => pendingPayload ?? null)
  ipcMain.handle(IPC.exportRendered, (_event, rawHeight: unknown) => {
    const height = typeof rawHeight === 'number' && rawHeight > 0 ? rawHeight : 0
    const resolve = resolveRenderHeight
    resolveRenderHeight = undefined
    resolve?.(height)
  })
}

async function openExportDialog(): Promise<void> {
  if (dialogWindow && !dialogWindow.isDestroyed()) {
    dialogWindow.show()
    dialogWindow.focus()
    return
  }
  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'export' }),
    width: 840,
    height: 560,
    minWidth: 680,
    minHeight: 420,
    maximizable: false,
    fullscreenable: false,
    title: '导出对话',
    backgroundColor: '#fafaf9',
    vibrancy: undefined
  })
  dialogWindow = win
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    dialogWindow = null
    pendingPayload = undefined
  })
  const entry = entryUrl('export')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
}

/**
 * PNG:普通窗口(非 offscreen),离屏位置短暂显示保证绘制。
 * 布局以 880 CSS 渲染;macOS 视网膜 DPR=2,capturePage 直接返回 2x 像素 ——
 * 文字放大、清晰,且不用 zoomFactor(那套在 offscreen 下只放大画布不放大文字)。
 */
async function capturePng(): Promise<void> {
  const base = baseWindowOptions({ kind: 'capture' })
  // 定位到主屏左缘只露出 8px:窗口在屏幕上,macOS 不会重新居中,但用户看不见;
  // 高度封顶,避免超高窗口盖住导出对话框。
  const display = screen.getPrimaryDisplay().bounds
  const win = new BrowserWindow({
    ...base,
    show: false,
    width: EXPORT_WIDTH,
    height: 800,
    x: display.x - EXPORT_WIDTH + 8,
    y: display.y + 24,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    backgroundColor: '#fafaf9',
    vibrancy: undefined
  })

  const renderReady = new Promise<number>((resolve) => {
    resolveRenderHeight = resolve
  })
  try {
    const entry = entryUrl('capture')
    await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
    const contentHeight = await renderReady
    win.setContentSize(EXPORT_WIDTH, Math.min(Math.max(contentHeight, 32), MAX_CAPTURE_HEIGHT))
    win.show()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const image = await win.webContents.capturePage()
    const data = image.isEmpty() ? Buffer.alloc(0) : image.toPNG()
    if (data.length === 0) throw new Error('导出失败(PNG)')
    await saveBuffer('png', data)
  } finally {
    resolveRenderHeight = undefined
    if (!win.isDestroyed()) win.destroy()
  }
}

/** PDF:普通隐藏窗口(非 offscreen),zoom 1,printToPDF 输出标准 A4,不受缩放影响。 */
async function capturePdf(): Promise<void> {
  const base = baseWindowOptions({ kind: 'capture' })
  const win = new BrowserWindow({
    ...base,
    show: false,
    width: EXPORT_WIDTH,
    height: 800,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    backgroundColor: '#fafaf9',
    vibrancy: undefined
  })

  const renderReady = new Promise<number>((resolve) => {
    resolveRenderHeight = resolve
  })
  try {
    const entry = entryUrl('capture')
    await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
    await renderReady
    const data = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 },
      displayHeaderFooter: false
    })
    if (data.length === 0) throw new Error('导出失败(PDF)')
    await saveBuffer('pdf', data)
  } finally {
    resolveRenderHeight = undefined
    if (!win.isDestroyed()) win.destroy()
  }
}

const SAVE_FILTERS: Record<ExportFormat, { name: string; extensions: string[] }[]> = {
  png: [{ name: 'PNG 图片', extensions: ['png'] }],
  pdf: [{ name: 'PDF 文档', extensions: ['pdf'] }]
}

async function saveBuffer(format: ExportFormat, data: Buffer): Promise<void> {
  if (!pendingPayload) throw new Error('没有可导出的数据')
  const defaultPath = defaultFileName(pendingPayload, format)
  const parent = BrowserWindow.getFocusedWindow() ?? undefined
  const options = { defaultPath, filters: SAVE_FILTERS[format] }
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  if (!result.canceled && result.filePath) await writeFile(result.filePath, data)
}

function defaultFileName(payload: ExportConversationPayload, format: ExportFormat): string {
  const name = [payload.projectName, payload.sessionTitle].filter(Boolean).join('-')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${name || '会话'}-${stamp}.${format}`
}

/** 轻校验导出载荷:只保留白名单字段,避免异常数据进入渲染页。 */
function sanitizePayload(raw: unknown): ExportConversationPayload {
  const source = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const items = Array.isArray(source.items)
    ? source.items.filter(
        (item): item is ExportConversationPayload['items'][number] =>
          typeof item === 'object' && item !== null
      )
    : []
  return {
    projectName: typeof source.projectName === 'string' ? source.projectName : '会话',
    ...(typeof source.sessionTitle === 'string' ? { sessionTitle: source.sessionTitle } : {}),
    ...(typeof source.adapterId === 'string' ? { adapterId: source.adapterId } : {}),
    items
  }
}
