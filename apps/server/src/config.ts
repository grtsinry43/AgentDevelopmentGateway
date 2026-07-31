import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

const serverConfigSchema = z.object({
  AGENT_GATEWAY_DATA_DIR: z
    .string()
    .min(1)
    .default(join(homedir(), '.agent-development-gateway', 'server')),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000)
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  return serverConfigSchema.parse(environment)
}
