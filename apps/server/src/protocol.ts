export const SERVER_VERSION = '0.0.0'
export const SERVER_PROTOCOL_VERSION = 6

export const SERVER_CAPABILITIES = [
  'projects',
  'sessions',
  'session-control',
  'session-execution-policy',
  'adapter-inspection',
  'workspace.files.list',
  'workspace.files.read',
  'workspace.files.write',
  'workspace.files.watch',
  'workspace.files.create',
  'workspace.files.rename',
  'workspace.files.delete',
  'workspace.files.copy',
  'workspace.files.download',
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
