import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'

/**
 * userData 下的 JSON 持久化。
 *
 * 写入是原子的:先写临时文件再 rename。直接覆写在崩溃/断电时会留下截断的 JSON,
 * 那意味着用户的最近工程列表整份丢失 —— 对一个每天要用的工具来说不可接受。
 *
 * 读失败(文件不存在、JSON 损坏)一律回落到默认值并记日志,绝不抛给调用方 ——
 * 偏好数据损坏不该阻塞应用启动。
 */
export class JsonStore<T> {
  readonly #path: string
  readonly #fallback: () => T
  /** 序列化写入,避免并发 save 互相覆盖。 */
  #writeChain: Promise<void> = Promise.resolve()
  #cache: T | undefined

  constructor(fileName: string, fallback: () => T) {
    this.#path = join(app.getPath('userData'), fileName)
    this.#fallback = fallback
  }

  async read(): Promise<T> {
    if (this.#cache !== undefined) return this.#cache

    try {
      const raw = await readFile(this.#path, 'utf8')
      this.#cache = JSON.parse(raw) as T
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        console.error(`[json-store] 读取 ${this.#path} 失败,使用默认值:`, error)
      }
      this.#cache = this.#fallback()
    }

    return this.#cache
  }

  async write(value: T): Promise<void> {
    this.#cache = value

    // 链式串行化:后一次写等前一次完成,保证磁盘上的最终状态是最后一次调用的值
    this.#writeChain = this.#writeChain.then(() => this.#writeAtomic(value))
    return this.#writeChain
  }

  /** 读-改-写。传入的 updater 拿到当前值,返回新值。 */
  async update(updater: (current: T) => T): Promise<T> {
    const next = updater(await this.read())
    await this.write(next)
    return next
  }

  async #writeAtomic(value: T): Promise<void> {
    const temp = `${this.#path}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await rename(temp, this.#path)
    } catch (error) {
      console.error(`[json-store] 写入 ${this.#path} 失败:`, error)
    }
  }
}
