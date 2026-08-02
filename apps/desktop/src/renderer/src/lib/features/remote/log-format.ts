/**
 * 远程 server 日志行解析(pino 结构化 JSON → 可读形态)。
 *
 * 原样透传的结构化日志是给日志系统解析的;渲染时按 level / req / res / err 字段
 * 拆成人可读的单行。非 JSON(启动早期输出、外部错误)原样回退。
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ParsedLogEntry {
	raw: string;
	level: LogLevel | undefined;
	/** 日志时间戳(ms)。 */
	time?: number;
	pid?: number;
	reqId?: string;
	method?: string;
	url?: string;
	statusCode?: number;
	msg: string;
	errorMessage?: string;
	/** 错误栈首行。 */
	errorStackFirst?: string;
}

const LEVEL_TONES: Record<number, LogLevel> = {
	10: 'trace',
	20: 'debug',
	30: 'info',
	40: 'warn',
	50: 'error',
	60: 'fatal'
};

export function parseServerLogLine(line: string): ParsedLogEntry {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== 'object' || value === null) return fallback(line);
		const record = value as Record<string, unknown>;
		if (typeof record.msg !== 'string') return fallback(line);

		const req = record.req as Record<string, unknown> | undefined;
		const res = record.res as Record<string, unknown> | undefined;
		const err = record.err as Record<string, unknown> | undefined;
		const stack = err?.stack;
		const stackFirst = Array.isArray(stack)
			? String(stack[0] ?? '')
			: typeof stack === 'string'
				? stack.split('\n')[0]
				: undefined;

		return {
			raw: line,
			level: typeof record.level === 'number' ? LEVEL_TONES[record.level] : undefined,
			time: typeof record.time === 'number' ? record.time : undefined,
			pid: typeof record.pid === 'number' ? record.pid : undefined,
			reqId: typeof record.reqId === 'string' ? record.reqId : undefined,
			method: typeof req?.method === 'string' ? req.method : undefined,
			url: typeof req?.url === 'string' ? req.url : undefined,
			statusCode: typeof res?.statusCode === 'number' ? res.statusCode : undefined,
			msg: record.msg,
			errorMessage: typeof err?.message === 'string' ? err.message : undefined,
			...(stackFirst ? { errorStackFirst: stackFirst } : {})
		};
	} catch {
		return fallback(line);
	}
}

function fallback(line: string): ParsedLogEntry {
	return { raw: line, level: undefined, msg: line };
}

export function formatLogTime(timestamp: number | undefined): string {
	if (timestamp === undefined) return '';
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, '0');
	return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
