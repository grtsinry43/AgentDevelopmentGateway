import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../contract/bridge.js'
import type { ManagedModel, ProviderProfileInput } from '../../contract/providers.js'
import {
  getProviderProfileSecret,
  listProviderProfiles,
  removeProviderProfile,
  saveProviderProfile,
  updateProviderModels,
  type ProviderProfileSecret,
} from '../store/provider-profiles.js'
import { broadcast } from './broadcast.js'

const providerProfileInputSchema = z.object({
  id: z.string().uuid().optional(),
  adapterId: z.enum(['claude-code', 'codex', 'opencode']),
  name: z.string().trim().min(1),
  baseUrl: z.string().trim().optional(),
  apiKey: z.string().optional(),
  removeApiKey: z.boolean().optional(),
  modelAliases: z.record(z.string(), z.string()).optional(),
  openaiCompatible: z.boolean().optional(),
  models: z
    .array(z.strictObject({ id: z.string().min(1), displayName: z.string().min(1) }))
    .optional(),
  enabled: z.boolean().optional(),
})

const managedModelSchema = z.strictObject({ id: z.string().min(1), displayName: z.string().min(1) })

async function announceProviders(): Promise<void> {
  broadcast({ kind: 'providers.changed', providers: await listProviderProfiles() })
}

export function registerProviderHandlers(): void {
  ipcMain.handle(IPC.providersList, () => listProviderProfiles())

  ipcMain.handle(IPC.providersSave, async (_event, rawInput: unknown) => {
    const input = providerProfileInputSchema.parse(rawInput) as ProviderProfileInput
    const saved = await saveProviderProfile(input)
    await announceProviders()
    return saved
  })

  ipcMain.handle(IPC.providersRemove, async (_event, rawId: unknown) => {
    await removeProviderProfile(z.string().uuid().parse(rawId))
    await announceProviders()
  })

  ipcMain.handle(IPC.providersScanModels, async (_event, rawId: unknown) => {
    const profileId = z.string().uuid().parse(rawId)
    const secret = await getProviderProfileSecret(profileId)
    if (!secret) throw new Error('提供商不存在或已被删除')
    const models = await fetchProviderModels(secret)
    await updateProviderModels(profileId, models)
    await announceProviders()
    return models.map((model) => managedModelSchema.parse(model))
  })
}

/**
 * 用 profile 的 baseUrl + key 探测模型列表。
 * - Anthropic 协议(claude-code;opencode 且非 OpenAI 兼容):GET {base}/v1/models,x-api-key
 * - OpenAI 兼容(codex;opencode 且 OpenAI 兼容):GET {base}/v1/models,Bearer
 * 返回的模型 id 存进 profile,composer 选该 profile 时直接用。
 */
export async function fetchProviderModels(secret: ProviderProfileSecret): Promise<ManagedModel[]> {
  if (!secret.apiKey) {
    throw new Error('请先保存 API Key 再探测模型')
  }
  const anthropic = secret.adapterId === 'claude-code' || secret.openaiCompatible === false
  const base = defaultBaseUrl(secret)
  const url = anthropic
    ? `${base}/v1/models`
    : base.endsWith('/v1')
      ? `${base}/models`
      : `${base}/v1/models`
  const headers: Record<string, string> = anthropic
    ? { 'x-api-key': secret.apiKey, 'anthropic-version': '2023-06-01' }
    : { Authorization: `Bearer ${secret.apiKey}` }

  let response: Response
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  } catch (error) {
    throw new Error(
      `模型探测失败:${error instanceof Error ? error.message : '无法连接'}`,
      { cause: error },
    )
  }
  if (!response.ok) {
    throw new Error(`模型探测失败:HTTP ${response.status}(${url})`)
  }
  let data: unknown
  try {
    data = await response.json()
  } catch {
    throw new Error('模型探测失败:返回内容不是合法 JSON')
  }
  const list = Array.isArray((data as { data?: unknown })?.data) ? (data as { data: unknown[] }).data : []
  return list
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => ({
      id: String(entry.id ?? entry.model ?? ''),
      displayName: String(entry.display_name ?? entry.name ?? entry.id ?? ''),
    }))
    .filter((model) => model.id.length > 0 && model.displayName.length > 0)
}

function defaultBaseUrl(secret: ProviderProfileSecret): string {
  const configured = secret.baseUrl?.replace(/\/+$/, '')
  if (configured) return configured
  const anthropic = secret.adapterId === 'claude-code' || secret.openaiCompatible === false
  return anthropic ? 'https://api.anthropic.com' : 'https://api.openai.com'
}
