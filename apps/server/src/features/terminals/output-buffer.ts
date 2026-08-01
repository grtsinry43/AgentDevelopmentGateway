export interface TerminalOutputChunk {
  sequence: number
  data: string
  bytes: number
  chars: number
}

export class TerminalOutputBuffer {
  private readonly chunks: TerminalOutputChunk[] = []
  private bytes = 0

  constructor(private readonly maxBytes: number) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      throw new Error('Terminal output buffer size must be a positive integer')
    }
  }

  append(sequence: number, data: string): TerminalOutputChunk | undefined {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) {
      throw new Error('Terminal output sequence must be a positive integer')
    }
    if (data.length === 0) return
    const chunk = { sequence, data, bytes: Buffer.byteLength(data), chars: data.length }

    if (chunk.bytes > this.maxBytes) {
      this.chunks.length = 0
      this.bytes = 0
      return chunk
    }

    this.chunks.push(chunk)
    this.bytes += chunk.bytes
    while (this.bytes > this.maxBytes) {
      const removed = this.chunks.shift()
      if (!removed) break
      this.bytes -= removed.bytes
    }
    return chunk
  }

  after(sequence: number, currentSequence: number): readonly TerminalOutputChunk[] | undefined {
    if (sequence === currentSequence) return []
    if (sequence > currentSequence) return undefined
    const first = this.chunks[0]
    if (!first || sequence < first.sequence - 1) return undefined
    return this.chunks.filter((chunk) => chunk.sequence > sequence)
  }
}
