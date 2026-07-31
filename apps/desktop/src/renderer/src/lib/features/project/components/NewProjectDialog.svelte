<script lang="ts">
	/**
	 * 新建工程对话框。
	 *
	 * 本地工程走原生目录选择器(路径必须真实存在);远程工程当前只能手填 —— Rust
	 * Remote Manager 是 Phase 2,现在没法枚举远程目录,也不做真实连接
	 * (计划风险条目 3)。
	 */
	import { basename } from '$lib/shared/utils/path';
	import { isDraftValid, pickDirectory } from '../api';
	import { launcher } from '../launcher.svelte';
	import type { ProjectDraft } from '../types';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Dialog from '$lib/ui/primitives/Dialog.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		open?: boolean;
		/** 打开时预设的类型。⌘N → local,⌘⇧N → ssh。 */
		initialHostType?: 'local' | 'ssh';
	}

	let { open = $bindable(false), initialHostType = 'local' }: Props = $props();

	const emptyDraft = (hostType: 'local' | 'ssh'): ProjectDraft => ({
		hostType,
		hostId: hostType === 'local' ? 'local' : '',
		path: '',
		name: ''
	});

	let draft = $state<ProjectDraft>(emptyDraft('local'));
	let submitting = $state(false);
	let error = $state<string | undefined>(undefined);
	/** 用户是否手动改过名称。改过就不再被路径覆盖。 */
	let nameTouched = $state(false);

	// 每次打开重置为干净草稿 —— 上次的输入残留会让人误提交。
	// 读 initialHostType 必须在 effect 里(它是 prop,会随 ⌘N / ⌘⇧N 变化)。
	$effect(() => {
		if (!open) return;
		draft = emptyDraft(initialHostType);
		nameTouched = false;
		error = undefined;
	});

	function setHostType(hostType: 'local' | 'ssh'): void {
		draft = { ...draft, hostType, hostId: hostType === 'local' ? 'local' : '' };
	}

	/** 路径变化时自动填名称,但不覆盖用户手输的值。 */
	function syncNameFromPath(path: string): void {
		if (nameTouched) return;
		draft.name = basename(path.replace(/[/\\]+$/, ''));
	}

	async function browse(): Promise<void> {
		const picked = await pickDirectory();
		if (!picked) return;
		draft.path = picked;
		syncNameFromPath(picked);
	}

	const valid = $derived(isDraftValid(draft));

	async function submit(): Promise<void> {
		if (!valid || submitting) return;
		submitting = true;
		error = undefined;
		try {
			await launcher.create(draft);
			open = false;
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			submitting = false;
		}
	}
</script>

<Dialog
	bind:open
	title="新建工程"
	description="工程由「路径 + 主机」共同标识,同一路径在不同主机上是两个工程。"
>
	<div class="flex flex-col gap-3">
		<!-- 类型切换:分段控件而不是下拉,两个选项用下拉是多一次点击 -->
		<div class="flex rounded-default border border-line p-0.5">
			{#each [{ value: 'local', label: '本地', icon: 'folder' }, { value: 'ssh', label: '远程 (SSH)', icon: 'server' }] as const as option (option.value)}
				<button
					type="button"
					class={[
						'flex h-6 flex-1 items-center justify-center gap-1.5 rounded-[2px] text-xs transition-colors',
						draft.hostType === option.value
							? 'bg-surface-active text-strong'
							: 'text-muted hover:text-strong'
					]}
					onclick={() => setHostType(option.value)}
				>
					<Icon name={option.icon} size={12} />
					{option.label}
				</button>
			{/each}
		</div>

		{#if draft.hostType === 'ssh'}
			<label class="flex flex-col gap-1">
				<span class="text-xs text-muted">主机</span>
				<Input bind:value={draft.hostId} placeholder="company-dev" mono />
				<span class="text-2xs text-faint">
					~/.ssh/config 里的 Host 别名。远程连接能力在后续阶段接入,现在只记录。
				</span>
			</label>
		{/if}

		<label class="flex flex-col gap-1">
			<span class="text-xs text-muted">路径</span>
			{#if draft.hostType === 'local'}
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
					<Button onclick={browse}>浏览…</Button>
				</div>
			{:else}
				<Input
					value={draft.path}
					placeholder="/srv/api"
					mono
					oninput={(event) => {
						const value = (event.currentTarget as HTMLInputElement).value;
						draft.path = value;
						syncNameFromPath(value);
					}}
				/>
			{/if}
		</label>

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

		{#if error}
			<p class="text-xs text-cinnabar-600 dark:text-cinnabar-400">{error}</p>
		{/if}
	</div>

	{#snippet footer()}
		<Button variant="ghost" onclick={() => (open = false)}>取消</Button>
		<Button variant="primary" disabled={!valid} loading={submitting} onclick={submit}>
			创建并打开
		</Button>
	{/snippet}
</Dialog>
