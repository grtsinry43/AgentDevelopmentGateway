/** 展示层格式化。纯函数,无副作用。 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间。控制台里「12 分钟前」比绝对时间有用得多。
 * 传入 `now` 便于测试与避免组件里散落 Date.now()。
 */
export function relativeTime(timestamp: number, now: number = Date.now()): string {
	const diff = now - timestamp;

	if (diff < 0) return '刚刚';
	if (diff < MINUTE) return '刚刚';
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
	if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;

	const date = new Date(timestamp);
	const sameYear = date.getFullYear() === new Date(now).getFullYear();
	const month = `${date.getMonth() + 1}`.padStart(2, '0');
	const day = `${date.getDate()}`.padStart(2, '0');
	return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}

/** token 计数:12400 → '12.4k'。密排 UI 里位数要稳定。 */
export function compactCount(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) {
		const k = value / 1000;
		return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
	}
	return `${(value / 1_000_000).toFixed(1)}m`;
}

/** 美元成本:总是两位小数以上,极小值不显示为 $0.00。 */
export function costUsd(value: number): string {
	if (value === 0) return '$0';
	if (value < 0.01) return '<$0.01';
	return `$${value.toFixed(2)}`;
}

/** 字节数。工具输出大小、文件大小用。 */
export function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
	return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 毫秒时长:820 → '820ms',4200 → '4.2s',95000 → '1m35s'。 */
export function duration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return `${minutes}m${seconds}s`;
}
