import { randomUUID } from 'node:crypto'
import { safeStorage } from 'electron'
import type { HostProfile, HostProfileInput } from '../../contract/hosts.js'
import { JsonStore } from './json-store.js'

/**
 * SSH 主机 Profile 存储。
 *
 * 密码三态:
 *  - rememberPassword → safeStorage(macOS Keychain)加密后落盘 encryptedPassword;
 *  - 否则 → 仅本次应用会话,存在内存 sessionPasswords;
 *  - 都没有 → 连接时报 PASSWORD_REQUIRED,由 UI 引导重新输入。
 * 渲染进程永远只见到 hasSavedPassword,看不到任何密文/明文。
 */
interface StoredHostProfile extends Omit<HostProfile, 'hasSavedPassword'> {
  encryptedPassword?: string
}

interface HostProfilesFile {
  version: 1
  hosts: StoredHostProfile[]
}

const store = new JsonStore<HostProfilesFile>('hosts.json', () => ({ version: 1, hosts: [] }))

/** 会话级密码(rememberPassword=false 的选择)。应用退出即消失。 */
const sessionPasswords = new Map<string, string>()

function toPublic(profile: StoredHostProfile): HostProfile {
  return {
    id: profile.id,
    name: profile.name,
    username: profile.username,
    hostname: profile.hostname,
    port: profile.port,
    auth: profile.auth,
    ...(profile.keyPath ? { keyPath: profile.keyPath } : {}),
    hasSavedPassword: Boolean(profile.encryptedPassword) || sessionPasswords.has(profile.id),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  }
}

export async function listHostProfiles(): Promise<HostProfile[]> {
  const file = await store.read()
  return [...file.hosts]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(toPublic)
}

export async function getHostProfile(id: string): Promise<HostProfile | undefined> {
  const file = await store.read()
  const found = file.hosts.find((host) => host.id === id)
  return found ? toPublic(found) : undefined
}

export async function saveHostProfile(input: HostProfileInput): Promise<HostProfile> {
  const now = Date.now()
  const encryptedPassword =
    input.auth === 'password' && input.password && input.rememberPassword
      ? encryptPassword(input.password)
      : undefined

  const file = await store.update((current) => {
    const existing = input.id ? current.hosts.find((host) => host.id === input.id) : undefined
    if (existing) {
      return {
        ...current,
        hosts: current.hosts.map((host) =>
          host.id === existing.id
            ? {
                ...host,
                name: input.name,
                username: input.username,
                hostname: input.hostname,
                port: input.port,
                auth: input.auth,
                ...(input.auth === 'key' && input.keyPath ? { keyPath: input.keyPath } : {}),
                // 密码:给了新密码就替换;没给且切到 key 就清掉;其余保留。
                ...(input.auth === 'key'
                  ? { encryptedPassword: undefined }
                  : input.password
                    ? { encryptedPassword }
                    : {}),
                updatedAt: now
              }
            : host
        )
      }
    }
    const created: StoredHostProfile = {
      id: randomUUID(),
      name: input.name,
      username: input.username,
      hostname: input.hostname,
      port: input.port,
      auth: input.auth,
      ...(input.auth === 'key' && input.keyPath ? { keyPath: input.keyPath } : {}),
      ...(encryptedPassword ? { encryptedPassword } : {}),
      createdAt: now,
      updatedAt: now
    }
    return { ...current, hosts: [...current.hosts, created] }
  })

  // 会话密码:新建/更新时若提供了明文但没选 remember,挂到内存。
  const saved = file.hosts.find((host) =>
    input.id ? host.id === input.id : host.name === input.name && host.updatedAt === now
  )
  if (!saved) throw new Error('保存主机失败')
  if (input.auth === 'password' && input.password && !input.rememberPassword) {
    sessionPasswords.set(saved.id, input.password)
  }
  if (input.auth === 'password' && input.password && input.rememberPassword) {
    sessionPasswords.delete(saved.id)
  }
  return toPublic(saved)
}

export async function removeHostProfile(id: string): Promise<void> {
  sessionPasswords.delete(id)
  await store.update((current) => ({
    ...current,
    hosts: current.hosts.filter((host) => host.id !== id)
  }))
}

/** 取连接用密码:优先会话缓存,其次 safeStorage 解密。 */
export async function getHostPassword(id: string): Promise<string | undefined> {
  const session = sessionPasswords.get(id)
  if (session) return session
  const file = await store.read()
  const stored = file.hosts.find((host) => host.id === id)
  if (!stored?.encryptedPassword) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(stored.encryptedPassword, 'base64'))
  } catch (error) {
    console.error(`[host-profiles] 解密主机密码失败(${id}):`, error)
    return undefined
  }
}

/** 会话级密码注入(密码重输 UI 接入前的入口,现在主要由 saveHostProfile 写入)。 */
export function setSessionPassword(id: string, password: string): void {
  sessionPasswords.set(id, password)
}

function encryptPassword(password: string): string | undefined {
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.encryptString(password).toString('base64')
  } catch (error) {
    console.error('[host-profiles] 加密主机密码失败:', error)
    return undefined
  }
}
