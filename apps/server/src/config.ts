import { z } from 'zod'

const serverConfigSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000)
})

export type ServerConfig = z.infer<typeof serverConfigSchema>

export function loadServerConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  return serverConfigSchema.parse(environment)
}
