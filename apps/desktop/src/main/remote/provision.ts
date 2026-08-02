/**
 * provision 编排:probe → (upload)→ install → start/reuse → 返回连接参数。
 * electron-free;阶段进度经回调抛给上层广播。
 */
import { z } from 'zod'
import {
  BOOTSTRAP_NEED_UPLOAD_CODE,
  buildBootstrapScript,
  parseListeningSentinel,
  parseNeededUpload,
  type BootstrapArtifactSet
} from './bootstrap-script.js'
import { runRemote, SshError, upload, type SshContext, type SshEndpoint } from './ssh.js'

export const listeningSchema = z.object({
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

export type ProvisionStage = 'probing' | 'uploading' | 'starting'

export interface ProvisionResult {
  port: number
  token?: string
  hostId: string
  serverVersion: string
  protocolVersion: number
}

export interface ProvisionOptions {
  artifacts: BootstrapArtifactSet
  /** target → 本地 tarball 路径(上传用)。 */
  localArtifactPath(target: string, file: string): string
  onStage?: (stage: ProvisionStage, message?: string) => void
}

export async function provision(
  context: SshContext,
  endpoint: SshEndpoint,
  options: ProvisionOptions
): Promise<ProvisionResult> {
  options.onStage?.('probing')
  const script = buildBootstrapScript(options.artifacts)
  let result = await runRemote(context, endpoint, script)

  if (result.code === BOOTSTRAP_NEED_UPLOAD_CODE) {
    const file = parseNeededUpload(result.stdout)
    if (!file) throw new SshError('failed', '远程 bootstrap 请求上传但未说明产物文件名')
    // 文件名形如 agent-gateway-server-<version>-<target>.tar.gz,target 是倒数第二段。
    const target = file.replace(/\.tar\.gz$/, '').split('-').slice(-2).join('-')
    options.onStage?.('uploading', file)
    await upload(context, endpoint, options.localArtifactPath(target, file), '.agent-development-gateway/server/downloads')
    options.onStage?.('starting')
    result = await runRemote(context, endpoint, script)
  }

  if (result.code !== 0) {
    const message =
      result.stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .find((line) => line.startsWith('AGW_ERROR')) ?? result.stderr.trim().split('\n')[0]
    throw new SshError('failed', message || `远程 bootstrap 失败(exit ${result.code})`)
  }

  const sentinel = parseListeningSentinel(result.stdout)
  const parsed = sentinel ? listeningSchema.safeParse(sentinel) : undefined
  if (!parsed?.success) {
    throw new SshError('failed', '远程 server 的监听哨兵缺失或格式非法')
  }
  if (parsed.data.protocolVersion !== options.artifacts.protocolVersion) {
    throw new SshError(
      'failed',
      `协议版本不匹配:客户端期望 ${options.artifacts.protocolVersion},远程 ${parsed.data.protocolVersion}`
    )
  }
  return {
    port: parsed.data.port,
    ...(parsed.data.token ? { token: parsed.data.token } : {}),
    hostId: parsed.data.hostId,
    serverVersion: parsed.data.version,
    protocolVersion: parsed.data.protocolVersion
  }
}
