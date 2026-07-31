import { APP_NAME } from '@agent-gateway/shared'
import { createModelDataContext } from 'svatoms'

export interface AppModel {
  intro: string
  title: string
}

export const initialAppModel: AppModel = {
  intro: [
    '## Workspace ready',
    '',
    'The desktop app uses **Electron**, **Svelte**, and shared workspace contracts.',
    '',
    'Server state is handled by TanStack Query; local view data is provided by svatoms.'
  ].join('\n'),
  title: APP_NAME
}

export const appModel = createModelDataContext<AppModel>({
  name: 'agent-gateway-app'
})
