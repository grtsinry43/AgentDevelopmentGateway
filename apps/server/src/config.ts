import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const serverConfigSchema = z.object({
  AGENT_GATEWAY_DATA_DIR: z
    .string()
    .min(1)
    .default(join(homedir(), '.agent-development-gateway', 'server')),
  /** 只允许 loopback 或显式配置;远程场景永远经 SSH tunnel 访问,不监听公网。 */
  AGENT_GATEWAY_HOST: z.string().min(1).default('127.0.0.1'),
  /** 0 = 内核分配临时端口,由 runtime.json / stdout 哨兵把真实端口回传给客户端。 */
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  AGENT_GATEWAY_AUTH: z.enum(['none', 'token']).default('none'),
  /** 显式指定连接 token;不指定且 AUTH=token 时启动时生成随机 token。 */
  AGENT_GATEWAY_CONNECTION_TOKEN: z.string().min(1).optional(),
  /** 默认 <dataDir>/runtime.json,供 bootstrap 脚本发现运行中的实例。 */
  AGENT_GATEWAY_RUNTIME_FILE: z.string().min(1).optional()
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  return serverConfigSchema.parse(environment)
}

/**
 * 解析生效的连接 token。显式 token 优先并隐含启用认证 —— 避免「设了 token 却忘了
 * 开 AUTH」造成的假安全。返回 undefined 表示不启用认证(本地开发的默认行为)。
 */
export function resolveConnectionToken(config: ServerConfig): string | undefined {
  if (config.AGENT_GATEWAY_CONNECTION_TOKEN) return config.AGENT_GATEWAY_CONNECTION_TOKEN
  if (config.AGENT_GATEWAY_AUTH === 'token') return randomBytes(32).toString('hex')
  return undefined
}
