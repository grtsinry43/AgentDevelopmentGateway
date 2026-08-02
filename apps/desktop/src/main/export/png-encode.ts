/**
 * 流式 PNG 编码:把多块 RGBA 位图(分块截屏产物)逐行喂进单个 zlib 流,拼成一张
 * 任意高度的 PNG。内存只随压缩输出增长,不随原始位图大小增长 —— 超长对话导出
 * 不会在渲染进程之外再吃一整块 GB 级 RGBA。
 *
 * PNG 结构:签名 + IHDR + IDAT(zlib 流 = deflate + adler32)+ IEND。
 * 每扫描行前置一个 0x00 filter(None),行数据按 RGBA 排列。
 */
import { createDeflate, crc32 } from 'node:zlib'

export class PngEncoder {
	private readonly rowBytes: number
	private readonly deflate = createDeflate()
	private readonly chunks: Buffer[] = []
	private finished = false

	constructor(
		readonly width: number,
		readonly height: number
	) {
		if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
			throw new Error(`无效的 PNG 尺寸 ${width}x${height}`)
		}
		this.rowBytes = width * 4
		this.deflate.on('data', (chunk: Buffer) => this.chunks.push(Buffer.from(chunk)))
	}

	/** 写入位图中 `[startRow, startRow+rows)` 的行(位图宽度必须等于构造时的 width)。 */
	writeRgbaRows(rgba: Buffer, startRow: number, rows: number): void {
		if (this.finished) throw new Error('PNG 已经结束')
		if (rows <= 0) return
		const { rowBytes } = this
		const start = startRow * rowBytes
		if (start < 0 || rgba.length < start + rowBytes * rows) {
			throw new Error('位图行数不足')
		}
		const tile = Buffer.allocUnsafe(rows * (rowBytes + 1))
		let offset = 0
		for (let r = 0; r < rows; r++) {
			tile[offset] = 0 // filter: None
			rgba.copy(tile, offset + 1, start + r * rowBytes, start + (r + 1) * rowBytes)
			offset += rowBytes + 1
		}
		this.deflate.write(tile)
	}

	/** 写入一段 RGBA 位图的前 `rows` 行(位图宽度必须等于构造时的 width)。 */
	writeRgba(rgba: Buffer, rows: number): void {
		this.writeRgbaRows(rgba, 0, rows)
	}

	/** 结束写入并返回完整 PNG 字节。 */
	async finish(): Promise<Buffer> {
		if (this.finished) throw new Error('PNG 已经结束')
		this.finished = true
		await new Promise<void>((resolve, reject) => {
			this.deflate.on('end', resolve)
			this.deflate.on('error', reject)
			this.deflate.end()
		})
		const idat = Buffer.concat(this.chunks)
		const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		const ihdr = Buffer.alloc(13)
		ihdr.writeUInt32BE(this.width, 0)
		ihdr.writeUInt32BE(this.height, 4)
		ihdr[8] = 8 // 位深
		ihdr[9] = 6 // 颜色类型 RGBA
		ihdr[10] = 0 // 压缩
		ihdr[11] = 0 // filter
		ihdr[12] = 0 // 隔行
		return Buffer.concat([
			signature,
			chunk('IHDR', ihdr),
			chunk('IDAT', idat),
			chunk('IEND', Buffer.alloc(0))
		])
	}
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length, 0)
	const typeBytes = Buffer.from(type, 'ascii')
	const checksum = Buffer.alloc(4)
	checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])) >>> 0, 0)
	return Buffer.concat([length, typeBytes, data, checksum])
}
