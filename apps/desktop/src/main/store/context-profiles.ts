import type { ContextProfile, ContextProfileSet } from '../../contract/project.js'
import { JsonStore } from './json-store.js'

interface ContextProfilesFile {
  version: 1
  /** projectKey → 该工程的 Profile 集合 */
  byProject: Record<string, ContextProfileSet>
}

const store = new JsonStore<ContextProfilesFile>('context-profiles.json', () => ({
  version: 1,
  byProject: {}
}))

const emptySet = (projectKey: string): ContextProfileSet => ({ projectKey, profiles: [] })

export async function listProfiles(projectKey: string): Promise<ContextProfileSet> {
  const file = await store.read()
  return file.byProject[projectKey] ?? emptySet(projectKey)
}

/**
 * 新增或更新一个 Profile。
 * 首个 Profile 自动激活 —— 用户建了唯一一份配置却还要手动点激活是多余的。
 */
export async function saveProfile(profile: ContextProfile): Promise<ContextProfile> {
  const next: ContextProfile = { ...profile, updatedAt: Date.now() }

  await store.update((current) => {
    const set = current.byProject[profile.projectKey] ?? emptySet(profile.projectKey)
    const exists = set.profiles.some((item) => item.id === profile.id)

    const profiles = exists
      ? set.profiles.map((item) => (item.id === profile.id ? next : item))
      : [...set.profiles, next]

    return {
      ...current,
      byProject: {
        ...current.byProject,
        [profile.projectKey]: {
          ...set,
          profiles,
          activeProfileId: set.activeProfileId ?? next.id
        }
      }
    }
  })

  return next
}

/** 删除。若删掉的是激活项,激活权顺移到剩下的第一个(而不是留下空激活态)。 */
export async function removeProfile(projectKey: string, profileId: string): Promise<void> {
  await store.update((current) => {
    const set = current.byProject[projectKey]
    if (!set) return current

    const profiles = set.profiles.filter((item) => item.id !== profileId)
    const activeProfileId =
      set.activeProfileId === profileId ? profiles[0]?.id : set.activeProfileId

    return {
      ...current,
      byProject: { ...current.byProject, [projectKey]: { ...set, profiles, activeProfileId } }
    }
  })
}

export async function activateProfile(
  projectKey: string,
  profileId: string | null
): Promise<void> {
  await store.update((current) => {
    const set = current.byProject[projectKey] ?? emptySet(projectKey)
    return {
      ...current,
      byProject: {
        ...current.byProject,
        [projectKey]: { ...set, activeProfileId: profileId ?? undefined }
      }
    }
  })
}
