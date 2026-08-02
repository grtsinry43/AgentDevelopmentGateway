import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { HostDirectoryResponse } from '@agent-gateway/shared'
import { GatewayHttpError } from '../../http/errors.js'

/**
 * 主机文件系统浏览。新建远程工程时选工程根目录用 —— 绕过 Project scope,
 * 直接读主机任意目录(token 认证保护,权限与 server 进程一致)。
 */
export class HostFilesService {
  async list(inputPath: string): Promise<HostDirectoryResponse> {
    const expanded = inputPath === '~' ? homedir() : inputPath.startsWith('~/') ? join(homedir(), inputPath.slice(2)) : inputPath
    const target = resolve(expanded)
    if (!isAbsolute(target)) {
      throw new GatewayHttpError(400, 'INVALID_WORKSPACE_PATH', '目录必须是绝对路径')
    }

    let entries: Dirent[]
    try {
      entries = await readdir(target, { withFileTypes: true })
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        throw new GatewayHttpError(404, 'FILE_NOT_FOUND', `目录不存在: ${target}`)
      }
      if (code === 'EACCES' || code === 'EPERM') {
        throw new GatewayHttpError(403, 'FILE_NOT_FOUND', `没有权限读取: ${target}`)
      }
      throw error
    }

    const listed = await Promise.all(
      entries.map(async (entry): Promise<HostDirectoryResponse['entries'][number]> => {
        const type = await resolveEntryType(target, entry)
        return { name: entry.name, type, symlink: entry.isSymbolicLink() }
      })
    )
    listed.sort(
      (a, b) =>
        (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name)
    )

    const parent = resolve(target, '..')
    return {
      path: target,
      parent: parent === target ? null : parent,
      entries: listed
    }
  }
}

async function resolveEntryType(directory: string, entry: Dirent): Promise<'dir' | 'file' | 'other'> {
  if (entry.isDirectory()) return 'dir'
  if (entry.isFile()) return 'file'
  if (entry.isSymbolicLink()) {
    // 符号链接:跟随到真实目标再判断,目录可继续导航。
    try {
      const info = await stat(join(directory, entry.name))
      return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other'
    } catch {
      return 'other'
    }
  }
  return 'other'
}
