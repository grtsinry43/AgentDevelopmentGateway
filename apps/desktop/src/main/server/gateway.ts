import type { WebContents } from 'electron'
import type { GatewayProject } from '@agent-gateway/shared'
import type { NewProjectInput, RecentProject } from '../../contract/project.js'
import { localServerManager } from '../local/server-manager.js'
import { ensureRemoteConnection } from '../remote/index.js'
import { getHostProfile } from '../store/host-profiles.js'
import { addProject, bindProjectToServer, findProject } from '../store/recent-projects.js'
import { migrateProjectState } from '../store/window-state.js'
import { projectKeyForWebContents } from '../windows/project.js'
import { GatewayServerClient } from './client.js'

export interface ResolvedProject {
  recent: RecentProject
  serverProjectId: string
  /** 该工程所在 server 的 client;本地与远程的差异到此为止。 */
  client: GatewayServerClient
}

/** 本地 server 的 client:复用运行中实例或拉起新的(本地主机生命周期管理)。 */
async function localClient(): Promise<GatewayServerClient> {
  const info = await localServerManager.ensure()
  return new GatewayServerClient(info.baseUrl)
}

export async function registerRecentProject(input: NewProjectInput): Promise<RecentProject> {
  if (input.hostType === 'ssh') {
    const { client, hostId } = await connectByProfileId(input.hostProfileId)
    const serverProject = await client.ensureProject(input.path, input.name)
    return addProject(
      {
        ...input,
        hostId,
        path: serverProject.path,
        ...(input.hostProfileId ? { hostProfileId: input.hostProfileId } : {})
      },
      serverProject.id
    )
  }
  const client = await localClient()
  const serverProject = await client.ensureProject(input.path, input.name)
  return addProject(
    {
      ...input,
      hostId: serverProject.hostId,
      path: serverProject.path
    },
    serverProject.id
  )
}

export async function resolveServerProject(projectKey: string): Promise<ResolvedProject> {
  const project = await findProject(projectKey)
  if (!project) throw new Error(`工程不存在: ${projectKey}`)

  if (project.hostType === 'ssh') {
    const { client } = await connectByProfileId(project.hostProfileId)
    const serverProject = await client.ensureProject(project.path, project.name)
    // hostId 以服务端为准:远程数据目录重建后 hostId 会变,工程 key 跟着迁移。
    const recent =
      serverProject.hostId === project.hostId && serverProject.path === project.path
        ? project
        : await rebindRemoteProject(project, serverProject)
    return { recent, serverProjectId: serverProject.id, client }
  }

  const client = await localClient()
  const serverProject = await client.ensureProject(project.path, project.name)
  const recent = await bindProjectToServer(projectKey, serverProject)
  await migrateProjectState(projectKey, recent.key)
  return { recent, serverProjectId: serverProject.id, client }
}

/**
 * 按事件来源窗口解析连接。工程窗口与 host 一一对应,所以 session/terminal 这类
 * 不带 projectKey 的 IPC 调用也能找到正确的 server —— 不需要维护 id 映射表。
 */
export async function resolveForSender(sender: WebContents): Promise<ResolvedProject> {
  const projectKey = projectKeyForWebContents(sender)
  if (!projectKey) throw new Error('无法确定调用来源所属的工程')
  return resolveServerProject(projectKey)
}

async function connectByProfileId(
  hostProfileId: string | undefined
): Promise<{ client: GatewayServerClient; hostId: string }> {
  if (!hostProfileId) throw new Error('远程工程缺少主机配置(hostProfileId)')
  const profile = await getHostProfile(hostProfileId)
  if (!profile) throw new Error('主机配置不存在或已被删除')
  const connection = await ensureRemoteConnection(profile)
  return {
    client: new GatewayServerClient(connection.baseUrl, connection.token),
    hostId: connection.hostId
  }
}

async function rebindRemoteProject(
  project: RecentProject,
  serverProject: GatewayProject
): Promise<RecentProject> {
  const rebound = await bindProjectToServer(project.key, serverProject)
  await migrateProjectState(project.key, rebound.key)
  return rebound
}
