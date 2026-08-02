/**
 * SSH 主机 Profile —— 存在本地的连接凭据(JetBrains 的 Saved SSH Configurations 对应物)。
 *
 * 安全边界:
 * - Profile 永不携带明文密码。密码要么用 safeStorage 加密后落盘(rememberPassword),
 *   要么只活在主进程内存里(会话级)。渲染进程只能看到 `hasSavedPassword`。
 * - `id` 是连接手段的稳定标识;工程的权威身份仍然是服务端 hostId(见 project.ts)。
 */

export type HostAuthMethod = 'key' | 'password';

/** 保存下来的主机 Profile(渲染进程可见)。 */
export interface HostProfile {
	id: string;
	/** 展示名,如 "家里 Linux"。 */
	name: string;
	username: string;
	/** IP 或域名。 */
	hostname: string;
	port: number;
	auth: HostAuthMethod;
	/** auth = key 时的私钥路径(客户端本机路径)。 */
	keyPath?: string;
	/** auth = password 且已加密保存时为 true;否则每次应用会话内需重新提供。 */
	hasSavedPassword: boolean;
	createdAt: number;
	updatedAt: number;
}

/** 新建/更新 Profile 的入参。明文密码只在这一跳里出现,主进程立刻加密或缓存。 */
export interface HostProfileInput {
	/** 提供即更新既有 Profile。 */
	id?: string;
	name: string;
	username: string;
	hostname: string;
	port: number;
	auth: HostAuthMethod;
	keyPath?: string;
	/** auth = password 时的明文;rememberPassword 决定加密落盘还是仅会话保存。 */
	password?: string;
	rememberPassword?: boolean;
}

/** 远程连接建立过程的阶段,随 remote.progress 推送。 */
export type RemoteProvisionStage =
	| 'connecting'
	| 'probing'
	| 'installing'
	| 'uploading'
	| 'starting'
	| 'tunneling'
	| 'ready'
	| 'error';

/** 远程连接的稳定状态,随 remote.state 推送;用于标题栏主机 chip。 */
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'error';
