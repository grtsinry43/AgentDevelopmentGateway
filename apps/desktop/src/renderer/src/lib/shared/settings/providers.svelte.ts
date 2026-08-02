import { desktop } from '$lib/shared/bridge/desktop';
import { pushBus } from '$lib/shared/bridge/events';
import type { ProviderProfile, ProviderProfileInput } from '$contract/providers';

/**
 * 提供商 Profile 状态。数据权威在主进程(safeStorage 管 key),这里只是投影。
 * 设置窗口与会话创建选择器共用;模块加载即订阅并拉取一次。
 */
class ProvidersStore {
	profiles = $state.raw<ProviderProfile[]>([]);
	loaded = $state(false);

	constructor() {
		pushBus.on('providers.changed', (event) => {
			this.profiles = event.providers;
			this.loaded = true;
		});
		void this.load();
	}

	async load(): Promise<void> {
		this.profiles = await desktop.providers.list();
		this.loaded = true;
	}

	/** 某适配器启用的 profile(会话创建选择器用)。 */
	enabledFor(adapterId: string): ProviderProfile[] {
		return this.profiles.filter((profile) => profile.adapterId === adapterId && profile.enabled);
	}

	async scanModels(id: string): Promise<ProviderProfile> {
		const models = await desktop.providers.scanModels(id);
		const current = this.profiles.find((profile) => profile.id === id);
		if (current) {
			this.profiles = this.profiles.map((profile) =>
				profile.id === id ? { ...profile, models } : profile
			);
		}
		return { ...(current ?? { models: [] }), models } as ProviderProfile;
	}

	async save(input: ProviderProfileInput): Promise<ProviderProfile> {
		const saved = await desktop.providers.save(input);
		void this.load();
		return saved;
	}

	async remove(id: string): Promise<void> {
		await desktop.providers.remove(id);
		void this.load();
	}
}

export const providers = new ProvidersStore();
