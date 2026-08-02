import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { ProviderAdapterId, ProviderProfile, ProviderProfileInput } from '../../contract/providers.js'
import { JsonStore } from './json-store.js'

/**
 * 提供商 Profile 存储。API key 用 safeStorage 加密落盘;渲染进程只见 hasApiKey。
 * 会话级明文 key(临时不落盘)暂不提供 —— 提供商 key 是长期凭据,不像主机密码需要
 * 每次会话重输,直接走加密落盘。
 */
interface StoredProviderProfile extends Omit<ProviderProfile, 'hasApiKey'> {
  encryptedApiKey?: string
}

interface ProviderProfilesFile {
  version: 1
  providers: StoredProviderProfile[]
}

const store = new JsonStore<ProviderProfilesFile>('providers.json', () => ({
  version: 1,
  providers: [],
}))

function toPublic(profile: StoredProviderProfile): ProviderProfile {
  return {
    id: profile.id,
    adapterId: profile.adapterId,
    name: profile.name,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    hasApiKey: Boolean(profile.encryptedApiKey),
    modelAliases: profile.modelAliases,
    openaiCompatible: profile.openaiCompatible,
    models: profile.models,
    enabled: profile.enabled,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

export async function listProviderProfiles(): Promise<ProviderProfile[]> {
  const file = await store.read()
  return [...file.providers]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toPublic)
}

export async function getProviderProfile(id: string): Promise<ProviderProfile | undefined> {
  const file = await store.read()
  const found = file.providers.find((profile) => profile.id === id)
  return found ? toPublic(found) : undefined
}

export async function saveProviderProfile(input: ProviderProfileInput): Promise<ProviderProfile> {
  const now = Date.now()
  const encryptedApiKey = input.apiKey ? encryptApiKey(input.apiKey) : undefined
  const file = await store.update((current) => {
    const existing = input.id ? current.providers.find((profile) => profile.id === input.id) : undefined
    if (existing) {
      return {
        ...current,
        providers: current.providers.map((profile) =>
          profile.id === existing.id
            ? {
                ...profile,
                name: input.name,
                adapterId: input.adapterId,
                ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl || undefined } : {}),
                ...(encryptedApiKey ? { encryptedApiKey } : {}),
                ...(input.removeApiKey ? { encryptedApiKey: undefined } : {}),
                modelAliases: input.modelAliases ?? profile.modelAliases,
                ...(input.openaiCompatible !== undefined
                  ? { openaiCompatible: input.openaiCompatible }
                  : {}),
                ...(input.models !== undefined ? { models: input.models } : {}),
                ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
                updatedAt: now,
              }
            : profile,
        ),
      }
    }
    const created: StoredProviderProfile = {
      id: randomUUID(),
      adapterId: input.adapterId,
      name: input.name,
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(encryptedApiKey ? { encryptedApiKey } : {}),
      modelAliases: input.modelAliases ?? {},
      openaiCompatible: input.openaiCompatible ?? true,
      models: input.models ?? [],
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    }
    return { ...current, providers: [...current.providers, created] }
  })
  const saved = file.providers.find((profile) =>
    input.id ? profile.id === input.id : profile.name === input.name && profile.updatedAt === now
  )
  if (!saved) throw new Error('保存提供商失败')
  return toPublic(saved)
}

export async function removeProviderProfile(id: string): Promise<void> {
  await store.update((current) => ({
    ...current,
    providers: current.providers.filter((profile) => profile.id !== id),
  }))
}

/** 探测/手动编辑后整体替换某个 profile 的模型列表。 */
export async function updateProviderModels(
  id: string,
  models: ProviderProfile['models'],
): Promise<ProviderProfile | undefined> {
  const now = Date.now()
  const file = await store.update((current) => ({
    ...current,
    providers: current.providers.map((profile) =>
      profile.id === id ? { ...profile, models, updatedAt: now } : profile,
    ),
  }))
  const stored = file.providers.find((profile) => profile.id === id)
  return stored ? toPublic(stored) : undefined
}

/** 取连接用明文 key(safeStorage 解密)。 */
export async function getProviderApiKey(id: string): Promise<string | undefined> {
  const file = await store.read()
  const stored = file.providers.find((profile) => profile.id === id)
  if (!stored?.encryptedApiKey) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
  } catch (error) {
    console.error(`[provider-profiles] 解密提供商 key 失败(${id}):`, error)
    return undefined
  }
}

/** 探测模型列表所需的连接信息(明文 key 只在主进程)。 */
export interface ProviderProfileSecret {
  adapterId: ProviderAdapterId
  baseUrl?: string
  apiKey?: string
  openaiCompatible: boolean
}

export async function getProviderProfileSecret(id: string): Promise<ProviderProfileSecret | undefined> {
  const file = await store.read()
  const stored = file.providers.find((profile) => profile.id === id)
  if (!stored) return undefined
  return {
    adapterId: stored.adapterId,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    apiKey: stored.encryptedApiKey
      ? (await getProviderApiKey(id))
      : undefined,
    openaiCompatible: stored.openaiCompatible,
  }
}

function encryptApiKey(apiKey: string): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.encryptString(apiKey).toString('base64')
  } catch (error) {
    console.error('[provider-profiles] 加密提供商 key 失败:', error)
    return undefined
  }
}
