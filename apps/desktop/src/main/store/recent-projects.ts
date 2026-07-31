import { randomUUID } from 'node:crypto'
import type { NewProjectInput, RecentProject } from '../../contract/project.js'
import { JsonStore } from './json-store.js'

interface RecentProjectsFile {
  version: 1
  projects: RecentProject[]
}

const store = new JsonStore<RecentProjectsFile>('recent-projects.json', () => ({
  version: 1,
  projects: []
}))

/** 主键。同一路径在不同 host 上是不同工程 —— 必须含 hostId。 */
export function projectKey(hostId: string, path: string): string {
  return `${hostId}:${path.replace(/[/\\]+$/, '')}`
}

/** 置顶优先,其次按最近打开时间。这是唯一的排序权威,渲染进程不再排。 */
function sortProjects(projects: RecentProject[]): RecentProject[] {
  return [...projects].sort((a, b) => {
    if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1
    return b.lastOpenedAt - a.lastOpenedAt
  })
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  const file = await store.read()
  return sortProjects(file.projects)
}

export async function findProject(key: string): Promise<RecentProject | undefined> {
  const file = await store.read()
  return file.projects.find((project) => project.key === key)
}

/**
 * 新增或「复活」一个工程。已存在同 key 时不产生重复条目,只更新名称与时间 ——
 * 用户重新选同一个目录时应该是「回到那个工程」,而不是多一张卡片。
 */
export async function addProject(input: NewProjectInput): Promise<RecentProject> {
  const key = projectKey(input.hostId, input.path)
  const now = Date.now()

  const file = await store.update((current) => {
    const existing = current.projects.find((project) => project.key === key)

    if (existing) {
      return {
        ...current,
        projects: current.projects.map((project) =>
          project.key === key ? { ...project, name: input.name, lastOpenedAt: now } : project
        )
      }
    }

    const created: RecentProject = {
      key,
      name: input.name,
      hostId: input.hostId,
      hostType: input.hostType,
      path: input.path,
      createdAt: now,
      lastOpenedAt: now
    }
    return { ...current, projects: [created, ...current.projects] }
  })

  const result = file.projects.find((project) => project.key === key)
  if (!result) throw new Error(`添加工程失败: ${key}`)
  return result
}

export async function removeProject(key: string): Promise<void> {
  await store.update((current) => ({
    ...current,
    projects: current.projects.filter((project) => project.key !== key)
  }))
}

export async function togglePinProject(key: string): Promise<RecentProject[]> {
  const file = await store.update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.key === key ? { ...project, pinned: !project.pinned } : project
    )
  }))
  return sortProjects(file.projects)
}

export async function touchProject(key: string): Promise<void> {
  const now = Date.now()
  await store.update((current) => ({
    ...current,
    projects: current.projects.map((project) =>
      project.key === key ? { ...project, lastOpenedAt: now } : project
    )
  }))
}

/** 给远程工程生成 hostId。Rust Remote Manager 接入后应改为真实 Host.id。 */
export function draftHostId(): string {
  return `ssh-${randomUUID().slice(0, 8)}`
}
