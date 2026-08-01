import * as nodePty from 'node-pty'

export interface TerminalPtyExit {
  exitCode: number
  signal?: number
}

export interface TerminalPtyDisposable {
  dispose(): void
}

export interface TerminalPty {
  readonly pid: number
  write(data: string): void
  resize(cols: number, rows: number): void
  pause(): void
  resume(): void
  kill(signal?: string): void
  onData(listener: (data: string) => void): TerminalPtyDisposable
  onExit(listener: (event: TerminalPtyExit) => void): TerminalPtyDisposable
}

export interface TerminalPtySpawnOptions {
  shell: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  name: string
}

export interface TerminalPtyFactory {
  spawn(options: TerminalPtySpawnOptions): TerminalPty
}

export class NodePtyFactory implements TerminalPtyFactory {
  spawn(options: TerminalPtySpawnOptions): TerminalPty {
    return nodePty.spawn(options.shell, [...options.args], {
      name: options.name,
      cwd: options.cwd,
      env: options.env,
      cols: options.cols,
      rows: options.rows
    })
  }
}
