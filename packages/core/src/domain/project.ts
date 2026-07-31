/**
 * Project — a logical project that may exist on multiple Hosts (requirements §7.2).
 * The same Project can have repositories checked out on several hosts.
 */
export interface Project {
  id: string
  name: string
  repositories: ProjectLocation[]
  memoryProfileId?: string
  skillProfileId?: string
}

export interface ProjectLocation {
  hostId: string
  path: string
}
