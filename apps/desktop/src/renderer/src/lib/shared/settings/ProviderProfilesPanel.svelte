<script lang="ts">
	/**
	 * 「提供商与模型」设置面板。集中管理三个 agent 运行时的认证与模型别名。
	 * 明文 key 只在编辑时出现,保存后主进程 safeStorage 加密;列表只显示 hasApiKey。
	 */
	import Button from '$lib/ui/primitives/Button.svelte';
	import Checkbox from '$lib/ui/primitives/Checkbox.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import { cx } from '$lib/shared/utils/cx';
	import type { ProviderAdapterId, ProviderProfile } from '$contract/providers';
	import { providers } from './providers.svelte';

	const ADAPTERS: Array<{ id: ProviderAdapterId; label: string }> = [
		{ id: 'claude-code', label: 'Claude Code' },
		{ id: 'codex', label: 'Codex' },
		{ id: 'opencode', label: 'OpenCode' }
	];

	function adapterLabel(id: ProviderAdapterId): string {
		return ADAPTERS.find((item) => item.id === id)?.label ?? id;
	}

	interface DraftAlias {
		alias: string;
		model: string;
	}

	interface Draft {
		id?: string;
		adapterId: ProviderAdapterId;
		name: string;
		baseUrl: string;
		apiKey: string;
		enabled: boolean;
		openaiCompatible: boolean;
		aliases: DraftAlias[];
		models: Array<{ id: string; displayName: string }>;
	}

	const emptyDraft = (adapterId: ProviderAdapterId = 'claude-code'): Draft => ({
		adapterId,
		name: '',
		baseUrl: '',
		apiKey: '',
		enabled: true,
		openaiCompatible: true,
		aliases: [],
		models: []
	});

	let editing = $state<Draft | undefined>(undefined);
	let busy = $state(false);
	let message = $state<{ kind: 'error' | 'ok'; text: string } | undefined>(undefined);

	function startEdit(profile?: ProviderProfile): void {
		message = undefined;
		if (!profile) {
			editing = emptyDraft();
			return;
		}
		editing = {
			id: profile.id,
			adapterId: profile.adapterId,
			name: profile.name,
			baseUrl: profile.baseUrl ?? '',
			apiKey: '',
			enabled: profile.enabled,
			openaiCompatible: profile.openaiCompatible,
			aliases: Object.entries(profile.modelAliases).map(([alias, model]) => ({ alias, model })),
			models: profile.models.map((model) => ({ ...model }))
		};
	}
	async function save(): Promise<void> {
		const draft = editing;
		if (!draft || busy) return;
		if (!draft.name.trim()) {
			message = { kind: 'error', text: '请输入提供商名称' };
			return;
		}
		busy = true;
		message = undefined;
		try {
			const aliases: Record<string, string> = {};
			for (const row of draft.aliases) {
				if (row.alias.trim() && row.model.trim()) aliases[row.alias.trim()] = row.model.trim();
			}
			await providers.save({
				...(draft.id ? { id: draft.id } : {}),
				adapterId: draft.adapterId,
				name: draft.name.trim(),
				...(draft.baseUrl.trim() ? { baseUrl: draft.baseUrl.trim() } : {}),
				...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
				enabled: draft.enabled,
				...(draft.adapterId === 'claude-code' ? { modelAliases: aliases } : {}),
				...(draft.adapterId === 'opencode' ? { openaiCompatible: draft.openaiCompatible } : {}),
				models: draft.models
					.map((model) => ({ id: model.id.trim(), displayName: model.displayName.trim() }))
					.filter((model) => model.id.length > 0)
			});
			editing = undefined;
		} catch (error) {
			message = { kind: 'error', text: error instanceof Error ? error.message : '保存失败' };
		} finally {
			busy = false;
		}
	}

	/** 探测模型列表(需 profile 已保存且有 key)。 */
	async function scanModels(): Promise<void> {
		const draft = editing;
		if (!draft?.id || busy) return;
		busy = true;
		message = undefined;
		try {
			const scanned = await providers.scanModels(draft.id);
			if (editing) editing.models = scanned.models.map((model) => ({ ...model }));
		} catch (error) {
			message = { kind: 'error', text: error instanceof Error ? error.message : '模型探测失败' };
		} finally {
			busy = false;
		}
	}
	async function remove(profile: ProviderProfile): Promise<void> {
		message = undefined;
		await providers.remove(profile.id);
		if (editing?.id === profile.id) editing = undefined;
	}
</script>

<div class="flex flex-col gap-4">
	<div class="flex items-center justify-between">
		<div class="flex flex-col gap-1">
			<span class="text-sm text-strong">提供商与模型</span>
			<p class="text-2xs text-faint">
				集中管理 Claude Code / Codex / OpenCode 的 API Key、中继地址与模型别名。Key
				由系统钥匙串加密保存。
			</p>
		</div>
		<Button variant="primary" size="sm" onclick={() => startEdit()}>
			{#snippet icon()}
				<Icon name="plus" size={11} />
			{/snippet}
			新建提供商
		</Button>
	</div>

	{#if message}
		<div
			class={cx(
				'rounded-default border px-3 py-2 text-xs',
				message.kind === 'error'
					? 'border-cinnabar-500/30 bg-cinnabar-500/8 text-status-error'
					: 'border-line bg-surface-raised text-normal'
			)}
		>
			{message.text}
		</div>
	{/if}

	{#if !providers.loaded}
		<div class="py-8 text-center text-xs text-faint">读取提供商…</div>
	{:else if providers.profiles.length === 0}
		<div
			class="rounded-default border border-dashed border-line px-4 py-8 text-center text-xs text-faint"
		>
			还没有配置提供商。点「新建提供商」添加一个。
		</div>
	{:else}
		<ul class="flex flex-col gap-2">
			{#each providers.profiles as profile (profile.id)}
				<li
					class="flex items-center gap-3 rounded-default border border-line bg-surface-raised px-3 py-2.5"
				>
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<span class="truncate text-sm text-strong">{profile.name}</span>
							<span
								class="shrink-0 rounded-full bg-surface-active px-1.5 py-0.5 text-2xs text-muted"
							>
								{adapterLabel(profile.adapterId)}
							</span>
							{#if !profile.enabled}
								<span class="shrink-0 text-2xs text-faint">已停用</span>
							{/if}
						</div>
						<div class="mt-0.5 flex min-w-0 items-center gap-2 text-2xs text-faint">
							<span class="truncate">{profile.baseUrl ?? '默认地址'}</span>
							<span aria-hidden="true">·</span>
							<span>{profile.hasApiKey ? '已保存 Key' : '未配置 Key'}</span>
							{#if profile.adapterId === 'claude-code' && Object.keys(profile.modelAliases).length > 0}
								<span aria-hidden="true">·</span>
								<span>{Object.keys(profile.modelAliases).length} 个别名</span>
							{/if}
						</div>
					</div>
					<div class="flex shrink-0 items-center gap-1">
						<Button variant="icon" size="sm" title="编辑" onclick={() => startEdit(profile)}>
							{#snippet icon()}
								<Icon name="pencil" size={11} />
							{/snippet}
						</Button>
						<Button variant="icon" size="sm" title="删除" onclick={() => void remove(profile)}>
							{#snippet icon()}
								<Icon name="trash" size={11} />
							{/snippet}
						</Button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}

	{#if editing}
		<div class="mt-2 flex flex-col gap-3 rounded-default border border-line bg-surface-raised p-4">
			<span class="text-sm text-strong">{editing.id ? '编辑提供商' : '新建提供商'}</span>

			<div class="grid grid-cols-2 gap-3">
				<label class="flex flex-col gap-1">
					<span class="text-2xs text-muted">适配器</span>
					<select
						class="h-7 rounded-default border border-line bg-surface-raised px-2 text-sm text-strong outline-none focus:border-line-accent"
						value={editing.adapterId}
						onchange={(event) => {
							editing!.adapterId = (event.currentTarget as HTMLSelectElement)
								.value as ProviderAdapterId;
							editing!.aliases = [];
						}}
					>
						{#each ADAPTERS as adapter (adapter.id)}
							<option value={adapter.id}>{adapter.label}</option>
						{/each}
					</select>
				</label>
				<label class="flex flex-col gap-1">
					<span class="text-2xs text-muted">名称</span>
					<Input type="text" bind:value={editing.name} placeholder="如 我的 Anthropic 直连" />
				</label>
			</div>

			<label class="flex flex-col gap-1">
				<span class="text-2xs text-muted">中继 / Base URL(可选,留空用 provider 默认)</span>
				<Input type="text" bind:value={editing.baseUrl} placeholder="https://api.example.com" />
			</label>

			<label class="flex flex-col gap-1">
				<span class="text-2xs text-muted">API Key</span>
				<Input
					type="password"
					bind:value={editing.apiKey}
					placeholder={editing.id ? '留空保持已保存的 Key' : '输入 API Key'}
				/>
			</label>

			{#if editing.adapterId === 'opencode'}
				<Checkbox
					checked={editing.openaiCompatible}
					label="接口为 OpenAI 兼容(不勾选 = Anthropic 兼容,如 CC Switch)"
					onchange={(value) => (editing!.openaiCompatible = value)}
				/>
			{/if}

			{#if editing.adapterId === 'claude-code'}
				<div class="flex flex-col gap-1.5">
					<span class="text-2xs text-muted"
						>模型别名映射(仅 Claude Code;会话里选别名,运行时解析成真实模型)</span
					>
					{#each editing.aliases as row, index (index)}
						<div class="flex items-center gap-1.5">
							<Input type="text" placeholder="别名,如 sonnet" bind:value={row.alias} />
							<span class="text-faint">→</span>
							<Input
								type="text"
								placeholder="真实模型 id,如 claude-sonnet-4-5"
								bind:value={row.model}
							/>
							<Button
								variant="icon"
								size="sm"
								title="删除别名"
								onclick={() => {
									editing!.aliases.splice(index, 1);
								}}
							>
								{#snippet icon()}
									<Icon name="trash" size={11} />
								{/snippet}
							</Button>
						</div>
					{/each}
					<Button
						variant="ghost"
						size="sm"
						onclick={() => editing!.aliases.push({ alias: '', model: '' })}
					>
						{#snippet icon()}
							<Icon name="plus" size={11} />
						{/snippet}
						添加别名
					</Button>
				</div>
			{/if}

			<div class="flex flex-col gap-1.5">
				<div class="flex items-center justify-between">
					<span class="text-2xs text-muted">模型列表(探测或手动添加;创建会话时展示)</span>
					<Button
						variant="ghost"
						size="sm"
						loading={busy}
						disabled={!editing.id}
						title={editing.id ? '用 baseUrl+Key 拉取 /v1/models' : '先保存 profile 再探测'}
						onclick={() => void scanModels()}
					>
						{#snippet icon()}
							<Icon name="refresh" size={11} />
						{/snippet}
						探测模型
					</Button>
				</div>
				{#each editing.models as model, index (index)}
					<div class="flex items-center gap-1.5">
						<Input type="text" placeholder="模型 id" bind:value={model.id} />
						<span class="text-faint">·</span>
						<Input type="text" placeholder="显示名" bind:value={model.displayName} />
						<Button
							variant="icon"
							size="sm"
							title="删除模型"
							onclick={() => {
								editing!.models.splice(index, 1);
							}}
						>
							{#snippet icon()}
								<Icon name="trash" size={11} />
							{/snippet}
						</Button>
					</div>
				{/each}
				<Button
					variant="ghost"
					size="sm"
					onclick={() => editing!.models.push({ id: '', displayName: '' })}
				>
					{#snippet icon()}
						<Icon name="plus" size={11} />
					{/snippet}
					添加模型
				</Button>
			</div>

			<Checkbox
				checked={editing.enabled}
				label="启用此提供商"
				onchange={(value) => (editing!.enabled = value)}
			/>

			<div class="flex items-center gap-2">
				<Button variant="primary" size="sm" loading={busy} onclick={() => void save()}>保存</Button>
				<Button variant="ghost" size="sm" onclick={() => (editing = undefined)}>取消</Button>
			</div>
		</div>
	{/if}
</div>
