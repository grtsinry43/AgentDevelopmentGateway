/** A concrete working directory on one Host, identified by `hostId + path`. */
export interface Project {
  id: string
  name: string
  hostId: string
  path: string
  memoryProfileId?: string
  skillProfileId?: string
}
