import { spawn } from 'node:child_process'

export interface GitCommandResult {
  exitCode: number
  stdout: Buffer
  stderr: Buffer
}

export interface GitCommandOptions {
  allowedExitCodes?: readonly number[]
  input?: Buffer | string
  maxOutputBytes?: number
  timeoutMs?: number
}

export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly reason: 'exit' | 'output-limit' | 'spawn' | 'timeout',
    readonly result?: GitCommandResult,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024

export class GitCommandRunner {
  constructor(private readonly environment: Record<string, string>) {}

  run(cwd: string, args: readonly string[], options: GitCommandOptions = {}): Promise<GitCommandResult> {
    const allowedExitCodes = new Set(options.allowedExitCodes ?? [0])
    const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      const child = spawn('git', [...args], {
        cwd,
        env: {
          ...this.environment,
          GIT_TERMINAL_PROMPT: '0',
          LANG: 'C',
          LC_ALL: 'C'
        },
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let outputBytes = 0
      let finished = false
      let limited = false
      let timedOut = false

      const timeout = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)

      const collect = (target: Buffer[]) => (chunk: Buffer): void => {
        outputBytes += chunk.byteLength
        if (outputBytes > maxOutputBytes) {
          limited = true
          child.kill()
          return
        }
        target.push(chunk)
      }
      child.stdout.on('data', collect(stdout))
      child.stderr.on('data', collect(stderr))
      child.once('error', (error) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        reject(new GitCommandError('Unable to start Git', 'spawn', undefined, error))
      })
      child.once('close', (code) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        const result: GitCommandResult = {
          exitCode: code ?? -1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr)
        }
        if (limited) {
          reject(new GitCommandError('Git output exceeded the configured limit', 'output-limit', result))
          return
        }
        if (timedOut) {
          reject(new GitCommandError('Git command timed out', 'timeout', result))
          return
        }
        if (!allowedExitCodes.has(result.exitCode)) {
          reject(new GitCommandError(gitErrorMessage(result), 'exit', result))
          return
        }
        resolve(result)
      })

      if (options.input === undefined) child.stdin.end()
      else child.stdin.end(options.input)
    })
  }
}

function gitErrorMessage(result: GitCommandResult): string {
  const stderr = result.stderr.toString('utf8').trim()
  return stderr || `Git exited with code ${result.exitCode}`
}
