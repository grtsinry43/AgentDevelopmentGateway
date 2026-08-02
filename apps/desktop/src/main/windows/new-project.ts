import { BrowserWindow } from 'electron'
import { baseWindowOptions, entryUrl } from './chrome.js'

const DEFAULT_SIZE = { width: 520, height: 640 }

/** 新建工程向导窗口。每次打开都是全新会话(否则残留上一步的选择)。 */
export async function openNewProjectWindow(
  initialHostType: 'local' | 'ssh' = 'local'
): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    ...baseWindowOptions({ kind: 'new-project', initialHostType }),
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    minWidth: 440,
    minHeight: 560,
    maximizable: false,
    fullscreenable: false,
    title: '新建工程'
  })

  win.once('ready-to-show', () => win.show())

  const entry = entryUrl('new-project')
  await (entry.url ? win.loadURL(entry.url) : win.loadFile(entry.file!))
  return win
}
