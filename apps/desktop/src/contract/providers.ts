/**
 * 提供商与模型 Profile —— 集中管理三个 agent 运行时(Claude Code / Codex / OpenCode)
 * 的认证信息、入口地址与模型别名。
 *
 * 安全边界(与 host-profiles 一致):
 * - Profile 永不携带明文 key。key 要么用 safeStorage 加密后落盘,要么只活在主进程内存。
 *   渲染进程只能看到 `hasApiKey`。
 * - 模型别名映射只对 Claude Code 有意义(其他两个 provider 是纯模型列表)。
 */

export type ProviderAdapterId = 'claude-code' | 'codex' | 'opencode';

/** profile 里保存的模型条目(探测或手动添加)。 */
export interface ManagedModel {
	id: string;
	displayName: string;
}

/** 保存下来的提供商 Profile(渲染进程可见)。 */
export interface ProviderProfile {
	id: string;
	adapterId: ProviderAdapterId;
	/** 展示名,如 "我的 Anthropic 直连"。 */
	name: string;
	/** 网关/中继地址(如 CC Switch 或自建代理);不填用 provider 默认。 */
	baseUrl?: string;
	/** key 已用 safeStorage 加密保存时为 true。 */
	hasApiKey: boolean;
	/** Claude 别名映射:别名 → 真实模型 id(仅 claude-code 使用)。 */
	modelAliases: Record<string, string>;
	/** OpenCode 接口风格:true=OpenAI 兼容,false=Anthropic 兼容(仅 opencode 使用)。 */
	openaiCompatible: boolean;
	/** 已保存的模型列表(探测或手动添加);composer 选该 profile 时展示。 */
	models: ManagedModel[];
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

/** 新建/更新 Profile 的入参。明文 key 只在这一跳出现,主进程立刻加密。 */
export interface ProviderProfileInput {
	/** 提供即更新既有 Profile。 */
	id?: string;
	adapterId: ProviderAdapterId;
	name: string;
	baseUrl?: string;
	/** 明文 API key;提供则保存,省略则保留原有。 */
	apiKey?: string;
	/** 显式清掉已保存的 key。 */
	removeApiKey?: boolean;
	modelAliases?: Record<string, string>;
	openaiCompatible?: boolean;
	/** 提供即整体替换已保存的模型列表。 */
	models?: ManagedModel[];
	enabled?: boolean;
}
