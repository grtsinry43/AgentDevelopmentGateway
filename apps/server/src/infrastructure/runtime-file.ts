import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'

/**
 * 运行实例发现文件:Server 启动后把真实端口、认证方式与身份信息写入
 * <dataDir>/runtime.json(0600),bootstrap 脚本据此复用已运行的实例,
 * 客户端则拿到建立 SSH 转发所需的端口与 token。
 * 单行 JSON:远程 bootstrap 用 shell 工具(cat/grep)即可解析,不依赖 python。
 */
export const serverRuntimeInfoSchema = z.strictObject({
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().positive().max(65_535),
  auth: z.enum(['none', 'token']),
  token: z.string().min(1).optional(),
  hostId: z.string().uuid(),
  version: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  startedAt: z.number().int().nonnegative()
})

export type ServerRuntimeInfo = z.infer<typeof serverRuntimeInfoSchema>

export function writeRuntimeFile(path: string, info: ServerRuntimeInfo): void {
  const payload = serverRuntimeInfoSchema.parse(info)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${Date.now()}-${process.pid}.tmp`)
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export function readRuntimeFile(path: string): ServerRuntimeInfo | undefined {
  try {
    return serverRuntimeInfoSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return undefined
  }
}

export function removeRuntimeFile(path: string): void {
  rmSync(path, { force: true })
}
