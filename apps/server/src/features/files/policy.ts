const HIDDEN_NAMES = new Set(['.DS_Store'])

const GENERATED_DIRECTORY_NAMES = new Set([
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.pnpm-store'
])

export class WorkspaceFilePolicy {
  isHidden(name: string): boolean {
    return HIDDEN_NAMES.has(name)
  }

  isGeneratedDirectory(name: string): boolean {
    return GENERATED_DIRECTORY_NAMES.has(name)
  }
}
