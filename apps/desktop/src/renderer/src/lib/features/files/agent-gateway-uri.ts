/** Custom scheme for workspace file references rendered in agent markdown. */
export const AGENT_GATEWAY_SCHEME = 'agent-gateway:';

const FILE_PREFIX = 'agent-gateway://';

/**
 * Parse `agent-gateway://relative/path` into a project-relative path.
 * Does not use URL host parsing — the first path segment is not an authority.
 */
export function parseAgentGatewayFileHref(href: string): string | null {
	const trimmed = href.trim();
	if (!trimmed.toLowerCase().startsWith(FILE_PREFIX)) return null;

	let remainder = trimmed.slice(FILE_PREFIX.length);
	while (remainder.startsWith('/')) {
		remainder = remainder.slice(1);
	}
	if (!remainder) return null;

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

	return decoded;
}
