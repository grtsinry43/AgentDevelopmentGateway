import { ipcMain } from 'electron'
import { IPC } from '../../contract/bridge.js'
import type { ContextProfile } from '../../contract/project.js'
import {
  activateProfile,
  listProfiles,
  removeProfile,
  saveProfile
} from '../store/context-profiles.js'
import { broadcast } from './broadcast.js'

export function registerContextProfileHandlers(): void {
  ipcMain.handle(IPC.contextProfilesList, async (_event, projectKey: string) => {
    const set = await listProfiles(projectKey)
    return { profiles: set.profiles, activeProfileId: set.activeProfileId }
  })

  ipcMain.handle(IPC.contextProfilesSave, async (_event, profile: ContextProfile) => {
    const saved = await saveProfile(profile)
    broadcast({ kind: 'contextProfiles.changed', projectKey: profile.projectKey })
    return saved
  })

  ipcMain.handle(
    IPC.contextProfilesRemove,
    async (_event, projectKey: string, profileId: string) => {
      await removeProfile(projectKey, profileId)
      broadcast({ kind: 'contextProfiles.changed', projectKey })
    }
  )

  ipcMain.handle(
    IPC.contextProfilesActivate,
    async (_event, projectKey: string, profileId: string | null) => {
      await activateProfile(projectKey, profileId)
      broadcast({ kind: 'contextProfiles.changed', projectKey })
    }
  )
}
