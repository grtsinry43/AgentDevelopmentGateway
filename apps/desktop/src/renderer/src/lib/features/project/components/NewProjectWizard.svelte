<script lang="ts">
	/**
	 * 新建工程向导(独立窗口,多步)。
	 *
	 * 类型由 Launcher 入口(新建/新建远程)决定,**不再单独选类型**:
	 *  - 远程:步骤 1 主机 → 步骤 2 路径与名称(目录树选工程根)→ 创建;
	 *  - 本地:直接 路径与名称(原生目录选择器)。
	 * 目录树浏览到的当前目录即工程根,无需再点「选择」,直接创建。
	 */
	import { basename } from '$lib/shared/utils/path';
	import RemotePathPicker from '$lib/features/remote/components/RemotePathPicker.svelte';
	import {
		createProjectFromDraft,
		hostDraftToInput,
		isDraftValid,
		isHostDraftValid,
		openProject,
		pickDirectory,
		pickKeyFile,
		removeHost,
		saveHost
	} from '../api';
	import { hostsStore } from '../hosts.svelte';
	import type { HostDraft, HostProfile, ProjectDraft, RemoteProvisionStage } from '../types';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		initialHostType: 'local' | 'ssh';
		ondone: () => void;
		oncancel: () => void;
	}

	let { initialHostType, ondone, oncancel }: Props = $props();

	const emptyHostDraft = (): HostDraft => ({
		name: '',
		username: '',
		hostname: '',
		port: '22',
		auth: 'key',
		keyPath: '',
		password: '',
		rememberPassword: true
	});

	const stageLabels: Record<RemoteProvisionStage, string> = {
		connecting: '建立 SSH 连接',
		probing: '探测远程环境',
		installing: '安装 server 产物',
		uploading: '上传 server 产物',
		starting: '启动远程 server',
		tunneling: '建立端口转发',
		ready: '连接就绪',
		error: '连接失败'
	};

	// initialHostType 来自窗口身份,创建后恒定不变;这里只用于初始状态。
	// svelte-ignore state_referenced_locally
	/** 当前步骤:'host' 仅远程有;本地直接进 'path'。 */
	let step = $state<'host' | 'path'>(initialHostType === 'ssh' ? 'host' : 'path');
	// svelte-ignore state_referenced_locally
	let draft = $state<ProjectDraft>({
		hostType: initialHostType,
		hostProfileId: '',
		host: emptyHostDraft(),
		path: '',
		name: ''
	});
	let editingId = $state<string | undefined>(undefined);
	let newHostActive = $state(false);
	let savingHost = $state(false);
	let submitting = $state(false);
	let error = $state<string | undefined>(undefined);
	let nameTouched = $state(false);

	const progress = $derived(submitting ? hostsStore.latest : undefined);
	const valid = $derived(isDraftValid(draft));
	const selectedHost = $derived(
		draft.hostProfileId
			? hostsStore.hosts.find((host) => host.id === draft.hostProfileId)
			: undefined
	);

	function selectHost(id: string): void {
		draft.hostProfileId = id;
		editingId = undefined;
		newHostActive = false;
		draft.path = '';
		error = undefined;
	}

	function startEdit(host: HostProfile): void {
		editingId = host.id;
		newHostActive = false;
		draft.host = {
			name: host.name,
			username: host.username,
			hostname: host.hostname,
			port: String(host.port),
			auth: host.auth,
			keyPath: host.keyPath ?? '',
			password: '',
			rememberPassword: true
		};
	}

	/** 保存新主机并选中。 */
	async function saveNewHost(): Promise<void> {
		if (!isHostDraftValid(draft.host) || savingHost) return;
		savingHost = true;
		error = undefined;
		try {
			const saved = await saveHost(hostDraftToInput(draft.host));
			draft.hostProfileId = saved.id;
			draft.host = emptyHostDraft();
			newHostActive = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			savingHost = false;
		}
	}

	async function saveHostEdit(): Promise<void> {
		if (!editingId) return;
		const valid =
			isHostDraftValid(draft.host) ||
			(draft.host.auth === 'password' && draft.host.password === '');
		if (!valid) return;
		await saveHost(hostDraftToInput(draft.host, editingId));
		editingId = undefined;
	}

	async function removeHostEdit(): Promise<void> {
		if (!editingId) return;
		const removed = editingId;
		await removeHost(removed);
		editingId = undefined;
		if (draft.hostProfileId === removed) draft.hostProfileId = '';
	}

	async function browseKey(): Promise<void> {
		const picked = await pickKeyFile();
		if (picked) draft.host.keyPath = picked;
	}

	function syncNameFromPath(path: string): void {
		if (nameTouched) return;
		draft.name = basename(path.replace(/[/\\]+$/, ''));
	}

	/** 主机步骤 → 下一步:选好的直接进;新建主机先保存再进。 */
	async function next(): Promise<void> {
		if (step !== 'host' || submitting) return;
		if (newHostActive && !draft.hostProfileId) {
			if (!isHostDraftValid(draft.host)) return;
			await saveNewHost();
			if (!draft.hostProfileId) return;
		}
		if (!draft.hostProfileId) return;
		step = 'path';
		error = undefined;
	}

	function back(): void {
		if (step === 'path' && initialHostType === 'ssh') {
			step = 'host';
			error = undefined;
		}
	}

	async function submit(): Promise<void> {
		if (!valid || submitting) return;
		submitting = true;
		error = undefined;
		try {
			const created = await createProjectFromDraft(draft);
			await openProject(created.key);
			ondone();
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			submitting = false;
		}
	}
</script>

<div class="flex h-full flex-col">
	<!-- 步骤指示条 -->
	<div class="flex items-center gap-1.5 border-b border-subtle px-5 py-2.5">
		{#if initialHostType === 'ssh'}
			<span class={['text-2xs', step === 'host' ? 'text-strong' : 'text-faint']}>1. 主机</span>
			<span class="text-faint">›</span>
			<span class={['text-2xs', step === 'path' ? 'text-strong' : 'text-faint']}>2. 路径与名称</span
			>
		{:else}
			<span class="text-2xs text-strong">路径与名称</span>
		{/if}
	</div>

	<main class="scroll-thin min-h-0 flex-1 overflow-y-auto p-5">
		{#if step === 'host'}
			<!-- 步骤 1(远程):主机 -->
			<div class="flex flex-col gap-3">
				<span class="text-xs text-muted">选择主机</span>
				<div
					class="flex max-h-40 flex-col gap-0.5 overflow-y-auto rounded-default border border-line p-1"
				>
					{#each hostsStore.hosts as host (host.id)}
						<div
							class={[
								'group flex h-7 items-center gap-2 rounded-[3px] px-2 text-xs',
								draft.hostProfileId === host.id && editingId === undefined
									? 'bg-surface-active text-strong'
									: 'text-muted hover:bg-surface-hover hover:text-strong'
							]}
						>
							<button
								type="button"
								class="flex flex-1 items-center gap-2 text-left"
								onclick={() => selectHost(host.id)}
							>
								<Icon name="server" size={12} class="shrink-0" />
								<span class="truncate">{host.name}</span>
								<span class="truncate text-2xs text-faint">
									{host.username}@{host.hostname}:{host.port}
								</span>
							</button>
							<button
								type="button"
								class="text-faint opacity-0 transition-opacity group-hover:opacity-100 hover:text-strong"
								title="编辑主机"
								onclick={() => startEdit(host)}
							>
								<Icon name="pencil" size={11} />
							</button>
						</div>
					{/each}
					<button
						type="button"
						class={[
							'flex h-7 items-center gap-2 rounded-[3px] px-2 text-xs',
							newHostActive
								? 'bg-surface-active text-strong'
								: 'text-muted hover:bg-surface-hover hover:text-strong'
						]}
						onclick={() => {
							editingId = undefined;
							newHostActive = true;
							draft.host = emptyHostDraft();
						}}
					>
						<Icon name="plus" size={12} />
						新建主机…
					</button>
				</div>

				{#if editingId || newHostActive}
					<div class="flex flex-col gap-2 rounded-default border border-line p-3">
						<div class="flex gap-2">
							<label class="flex flex-1 flex-col gap-1">
								<span class="text-2xs text-muted">地址</span>
								<Input
									bind:value={draft.host.hostname}
									placeholder="192.168.1.6 或 dev.example.com"
									mono
								/>
							</label>
							<label class="flex w-20 flex-col gap-1">
								<span class="text-2xs text-muted">端口</span>
								<Input bind:value={draft.host.port} placeholder="22" mono />
							</label>
						</div>
						<div class="flex gap-2">
							<label class="flex flex-1 flex-col gap-1">
								<span class="text-2xs text-muted">用户名</span>
								<Input bind:value={draft.host.username} placeholder="grtsinry43" mono />
							</label>
							<label class="flex flex-1 flex-col gap-1">
								<span class="text-2xs text-muted">名称(可选)</span>
								<Input bind:value={draft.host.name} placeholder="默认 用户名@地址" />
							</label>
						</div>
						<div class="flex rounded-default border border-line p-0.5">
							{#each [{ value: 'key', label: '私钥' }, { value: 'password', label: '密码' }] as const as option (option.value)}
								<button
									type="button"
									class={[
										'flex h-5.5 flex-1 items-center justify-center rounded-[2px] text-2xs transition-colors',
										draft.host.auth === option.value
											? 'bg-surface-active text-strong'
											: 'text-muted hover:text-strong'
									]}
									onclick={() => (draft.host.auth = option.value)}
								>
									{option.label}
								</button>
							{/each}
						</div>
						{#if draft.host.auth === 'key'}
							<label class="flex flex-col gap-1">
								<span class="text-2xs text-muted">私钥</span>
								<div class="flex gap-1.5">
									<Input
										bind:value={draft.host.keyPath}
										placeholder="~/.ssh/id_ed25519"
										mono
										class="flex-1"
									/>
									<Button onclick={browseKey}>浏览…</Button>
								</div>
							</label>
						{:else}
							<label class="flex flex-col gap-1">
								<span class="text-2xs text-muted">
									密码{editingId ? '(留空则保持已保存的密码)' : ''}
								</span>
								<Input bind:value={draft.host.password} type="password" placeholder="••••••••" />
							</label>
							<label class="flex items-center gap-1.5 text-2xs text-muted">
								<input
									type="checkbox"
									bind:checked={draft.host.rememberPassword}
									class="accent-current"
								/>
								记住密码(系统钥匙串加密保存)
							</label>
						{/if}

						{#if editingId}
							<div class="mt-1 flex items-center gap-1.5">
								<Button size="sm" variant="primary" onclick={() => void saveHostEdit()}>
									保存主机
								</Button>
								<Button size="sm" variant="ghost" onclick={() => (editingId = undefined)}
									>取消</Button
								>
								<span class="flex-1"></span>
								<Button size="sm" variant="danger" onclick={() => void removeHostEdit()}
									>删除</Button
								>
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{:else}
			<!-- 步骤 2:路径与名称 -->
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-2">
					<span class="text-xs text-muted">路径</span>
					{#if initialHostType === 'ssh'}
						{#if selectedHost}
							<RemotePathPicker
								hostProfileId={draft.hostProfileId}
								selectedPath={draft.path}
								onpathchange={(path) => {
									draft.path = path;
									syncNameFromPath(path);
								}}
							/>
						{:else}
							<p class="text-2xs text-faint">请先在上一步选择一台主机。</p>
						{/if}
					{:else}
						<div class="flex gap-1.5">
							<Input
								value={draft.path}
								placeholder="选择一个目录"
								mono
								class="flex-1"
								oninput={(event) => {
									const value = (event.currentTarget as HTMLInputElement).value;
									draft.path = value;
									syncNameFromPath(value);
								}}
							/>
							<Button
								onclick={async () => {
									const picked = await pickDirectory();
									if (picked) {
										draft.path = picked;
										syncNameFromPath(picked);
									}
								}}
							>
								浏览…
							</Button>
						</div>
						<span class="text-2xs text-faint">本地工程需选择真实存在的目录。</span>
					{/if}
				</div>

				<label class="flex flex-col gap-1">
					<span class="text-xs text-muted">名称</span>
					<Input
						value={draft.name}
						placeholder="默认取路径末段"
						oninput={(event) => {
							nameTouched = true;
							draft.name = (event.currentTarget as HTMLInputElement).value;
						}}
					/>
				</label>

				{#if progress && progress.stage !== 'ready' && progress.stage !== 'error'}
					<p class="flex items-center gap-1.5 text-xs text-muted">
						<span
							class="inline-block h-2.5 w-2.5 animate-spin rounded-full border border-line-accent border-t-transparent"
						></span>
						{stageLabels[progress.stage]}{progress.message ? ` · ${progress.message}` : ''}…
					</p>
				{/if}

				{#if error}
					<p class="text-xs text-cinnabar-600 dark:text-cinnabar-400">{error}</p>
				{/if}
			</div>
		{/if}
	</main>

	<div class="flex shrink-0 items-center justify-end gap-1.5 border-t border-subtle px-5 py-3">
		<Button variant="ghost" onclick={oncancel}>取消</Button>
		<span class="flex-1"></span>
		{#if step === 'path' && initialHostType === 'ssh'}
			<Button variant="ghost" disabled={submitting} onclick={back}>上一步</Button>
		{/if}
		{#if step === 'host'}
			<Button variant="primary" onclick={() => void next()}>下一步</Button>
		{:else}
			<Button
				variant="primary"
				disabled={!valid}
				loading={submitting}
				onclick={() => void submit()}
			>
				创建并打开
			</Button>
		{/if}
	</div>
</div>
