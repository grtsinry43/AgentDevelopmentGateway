/** Custom scheme for workspace file references rendered in agent markdown. */
export const AGENT_GATEWAY_SCHEME = 'agent-gateway:';

const FILE_PREFIX = 'agent-gateway://';

export interface AgentGatewayFileRef {
	/** 项目相对路径。 */
	path: string;
	/** 单行定位,`path:12`。 */
	line?: number;
	/** 行号区间起始,`path:10-20`。 */
	startLine?: number;
	/** 行号区间结束。 */
	endLine?: number;
}

/**
 * Parse `agent-gateway://relative/path[:LINE|:START-END]` into a project-relative
 * path plus an optional line range. Does not use URL host parsing — the first
 * path segment is not an authority. The line suffix is split off the last `:`
 * because macOS/Linux paths rarely contain colons.
 */
export function parseAgentGatewayFileHref(href: string): AgentGatewayFileRef | null {
	const trimmed = href.trim();
	if (!trimmed.toLowerCase().startsWith(FILE_PREFIX)) return null;

	let remainder = trimmed.slice(FILE_PREFIX.length);
	while (remainder.startsWith('/')) {
		remainder = remainder.slice(1);
	}
	if (!remainder) return null;

	// 行号区间:匹配尾部 `:N` 或 `:N-M`。
	let lineRange: { line?: number; startLine?: number; endLine?: number } | undefined;
	const lineMatch = /:(\d+)(?:-(\d+))?$/.exec(remainder);
	if (lineMatch) {
		const start = Number(lineMatch[1]);
		const end = lineMatch[2] ? Number(lineMatch[2]) : undefined;
		lineRange =
			end !== undefined && end >= start ? { startLine: start, endLine: end } : { line: start };
		remainder = remainder.slice(0, lineMatch.index);
	}

	let decoded: string;
	try {
		decoded = decodeURIComponent(remainder);
	} catch {
		return null;
	}

	if (
		decoded.includes('\0') ||
		decoded.startsWith('/') ||
		decoded.includes('\\') ||
		decoded.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
	) {
		return null;
	}

	return { path: decoded, ...lineRange };
}
