/**
 * 路径处理。渲染进程在 sandbox 下拿不到 node:path,所以这些是纯字符串实现。
 *
 * 工程标识形如 `path @ hostId` —— 对应 core 的 `ProjectLocation { hostId, path }`。
 */

/** POSIX 与 Windows 分隔符都要处理:远程主机可能是 Linux,本地可能是 Windows。 */
const SEPARATOR = /[/\\]/;

/** 取路径最后一段作为默认工程名。`/a/b/c/` → 'c'。 */
export function basename(path: string): string {
	const parts = path.split(SEPARATOR).filter(Boolean);
	return parts.at(-1) ?? path;
}

/** 父目录。`/a/b/c` → '/a/b'。 */
export function dirname(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, '');
	const index = trimmed.search(/[/\\][^/\\]*$/);
	return index <= 0 ? trimmed.slice(0, index + 1) || '/' : trimmed.slice(0, index);
}

/**
 * 把 home 前缀折成 `~`。homeDir 由主进程通过 bridge 提供 —— 渲染进程不该猜。
 * homeDir 缺失时原样返回,不做启发式判断。
 */
export function tildify(path: string, homeDir: string | undefined): string {
	if (!homeDir) return path;
	const normalized = homeDir.replace(/[/\\]+$/, '');
	if (path === normalized) return '~';
	if (path.startsWith(`${normalized}/`) || path.startsWith(`${normalized}\\`)) {
		return `~${path.slice(normalized.length)}`;
	}
	return path;
}

/**
 * 中间省略的路径缩写,保留头尾。密排 UI 里比末尾截断可读。
 * `/Users/x/very/deep/nested/project` → `/Users/x/…/nested/project`
 */
export function shortenPath(path: string, maxSegments = 4): string {
	const isAbsolute = SEPARATOR.test(path.charAt(0));
	const parts = path.split(SEPARATOR).filter(Boolean);
	if (parts.length <= maxSegments) return path;

	const head = parts.slice(0, 1);
	const tail = parts.slice(-(maxSegments - 2));
	const joined = [...head, '…', ...tail].join('/');
	return isAbsolute ? `/${joined}` : joined;
}

/**
 * 工程的稳定标识。同一路径在不同 host 上是不同工程,所以 key 必须含 hostId。
 * 用作 recent-projects 的主键与 Project 窗口的去重键。
 */
export function projectKey(hostId: string, path: string): string {
	return `${hostId}:${path.replace(/[/\\]+$/, '')}`;
}

/**
 * 展示用标签:`~/project` 或(远程)`~/project @192.168.1.6`。
 * hostLabel 是**已经加工好的展示主机**(hostname/IP/域名);本地工程传空则无 `@` 后缀。
 * 工程内部身份用的 hostId(服务端 UUID)不该出现在这里。
 */
export function projectLabel(
	path: string,
	homeDir?: string,
	maxSegments = 4,
	hostLabel?: string
): string {
	const base = shortenPath(tildify(path, homeDir), maxSegments);
	return hostLabel ? `${base} @${hostLabel}` : base;
}
