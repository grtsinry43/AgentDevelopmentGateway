import { BrowserWindow } from 'electron'
import { baseWindowOptions, entryUrl } from './chrome.js'

let window: BrowserWindow | null = null
/** 触发本次选择的来源窗口 id(This Window 的替换目标)。 */
let sourceWindowId: number | undefined
let chooserProjectKey: string | undefined

/** 打开工程选择器窗口:确认「在此窗口 / 新窗口打开」。无红绿灯。 */
export async function openProjectChooser(
  projectKey: string,
  sourceWebContentsId: number
): Promise<BrowserWindow> {
  if (window && !window.isDestroyed()) {
    window.show()
    window.focus()
    return window
  }

  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'open-project', projectKey }),
    width: 500,
    height: 200,
    minWidth: 460,
    minHeight: 200,
    maximizable: false,
    fullscreenable: false,
    resizable: false,
    title: '打开工程'
  })
  // 选择器窗口不需要 macOS 红绿灯。
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false)

  window = win
  sourceWindowId = sourceWebContentsId
  chooserProjectKey = projectKey
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    window = null
    sourceWindowId = undefined
    chooserProjectKey = undefined
  })

  const entry = entryUrl('open-project')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
  return win
}

/** 选择器确认后要打开的工程与来源窗口。 */
export function projectChooserContext(): {
  projectKey: string
  sourceWindowId: number
} | undefined {
  if (!chooserProjectKey || sourceWindowId === undefined) return undefined
  return { projectKey: chooserProjectKey, sourceWindowId }
}

export function closeProjectChooser(): void {
  window?.close()
}
