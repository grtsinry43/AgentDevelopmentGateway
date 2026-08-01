export const SERVER_VERSION = '0.0.0'
export const SERVER_PROTOCOL_VERSION = 5

export const SERVER_CAPABILITIES = [
  'projects',
  'sessions',
  'session-control',
  'session-execution-policy',
  'adapter-inspection',
  'workspace.files.list',
  'workspace.files.watch',
  'workspace.git.status',
  'workspace.git.diff',
  'workspace.git.stage',
  'workspace.git.unstage',
  'workspace.git.commit',
  'workspace.git.watch',
  'workspace.terminals.list',
  'workspace.terminals.create',
  'workspace.terminals.attach'
] as const
