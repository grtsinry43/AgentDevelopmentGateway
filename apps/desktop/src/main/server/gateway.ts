import type { NewProjectInput, RecentProject } from '../../contract/project.js'
import { addProject, bindProjectToServer, findProject } from '../store/recent-projects.js'
import { migrateProjectState } from '../store/window-state.js'
import { GatewayServerClient } from './client.js'

export const gatewayServer = new GatewayServerClient()

export async function registerRecentProject(input: NewProjectInput): Promise<RecentProject> {
  if (input.hostType !== 'local') return addProject(input)
  const serverProject = await gatewayServer.ensureProject(input.path, input.name)
  return addProject(
    {
      ...input,
      hostId: serverProject.hostId,
      path: serverProject.path
    },
    serverProject.id
  )
}

export async function resolveServerProject(projectKey: string): Promise<{
  recent: RecentProject
  serverProjectId: string
}> {
  const project = await findProject(projectKey)
  if (!project) throw new Error(`工程不存在: ${projectKey}`)
  if (project.hostType !== 'local') {
    throw new Error('远程 Server 尚未接入；当前阶段只支持本地项目')
  }

  const serverProject = await gatewayServer.ensureProject(project.path, project.name)
  const recent = await bindProjectToServer(projectKey, serverProject)
  await migrateProjectState(projectKey, recent.key)
  return { recent, serverProjectId: serverProject.id }
}
