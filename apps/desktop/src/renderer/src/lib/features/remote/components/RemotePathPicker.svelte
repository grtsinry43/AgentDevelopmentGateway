<script lang="ts">
	/**
	 * 远程目录树选择器(JetBrains Gateway 式)。新建远程工程时选工程根目录:
	 * 连接主机 → 从 home 开始浏览,目录可展开导航,面包屑跳转;也可手动输入路径
	 * 并回车(回车会校验:加载失败即报错)。选中当前目录返回 absolute path。
	 */
	import { hostsStore } from '$lib/features/project/hosts.svelte';
	import { browseDirectory } from '../api';
	import Button from '$lib/ui/primitives/Button.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	interface Props {
		hostProfileId: string;
		/** 当前已选中的工程根(显示用)。 */
		selectedPath?: string;
		/** 每次导航到新目录时上报(当前目录即工程根候选,无需再点「选择」)。 */
		onpathchange?: (path: string) => void;
	}

	let { hostProfileId, selectedPath = '', onpathchange }: Props = $props();

	let path = $state('~');
	let entries = $state.raw<
		Array<{ name: string; type: 'dir' | 'file' | 'other'; symlink: boolean }>
	>([]);
	let parent = $state<string | null>(null);
	let loading = $state(true);
	let error = $state<string | undefined>(undefined);
	let pathInput = $state('~');

	const currentHost = $derived(hostsStore.hosts.find((host) => host.id === hostProfileId));

	async function load(target: string): Promise<void> {
		loading = true;
		error = undefined;
		try {
			const listing = await browseDirectory(hostProfileId, target);
			path = listing.path;
			parent = listing.parent;
			entries = listing.entries;
			pathInput = listing.path;
			// 当前目录即工程根候选,直接上报 —— 无需再点「选择」。
			onpathchange?.(listing.path);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		} finally {
			loading = false;
		}
	}

	function navigateTo(name: string): void {
		void load(path === '/' ? `/${name}` : `${path}/${name}`);
	}

	function goUp(): void {
		if (parent) void load(parent);
	}

	/** 跳转到面包屑对应层级。 */
	function jumpTo(index: number): void {
		const segments = path.split('/').filter(Boolean);
		void load('/' + segments.slice(0, index + 1).join('/'));
	}

	function submitPath(): void {
		void load(pathInput.trim());
	}

	$effect(() => {
		// 主机切换时从头浏览。
		void load('~');
	});

	const segments = $derived(path.split('/').filter(Boolean));
</script>

<div class="flex flex-col gap-2">
	<div class="flex items-center gap-1.5">
		<Icon name="server" size={12} class="shrink-0 text-faint" />
		<span class="truncate text-2xs text-muted">
			{currentHost?.hostname ?? '远程主机'}
		</span>
		{#if loading}
			<span
				class="ml-auto inline-block h-2.5 w-2.5 animate-spin rounded-full border border-line-accent border-t-transparent"
			></span>
		{/if}
	</div>

	<!-- 手动输入(兜底,会校验) -->
	<div class="flex gap-1.5">
		<Input bind:value={pathInput} placeholder="~ 或 /home/user/project" mono class="flex-1" />
		<Button variant="secondary" size="sm" onclick={submitPath}>跳转</Button>
	</div>

	<!-- 面包屑 -->
	<div class="flex min-h-5 items-center gap-0.5 overflow-x-auto text-2xs text-faint">
		<button type="button" class="shrink-0 hover:text-strong" onclick={() => void load('~')}>
			~
		</button>
		{#each segments as segment, index (index)}
			<span class="shrink-0">/</span>
			<button
				type="button"
				class={['shrink-0 hover:text-strong', index === segments.length - 1 ? 'text-strong' : '']}
				onclick={() => jumpTo(index)}
			>
				{segment}
			</button>
		{/each}
		{#if parent}
			<button type="button" class="ml-1 shrink-0 hover:text-strong" onclick={goUp}>↑</button>
		{/if}
	</div>

	{#if error}
		<p class="text-2xs text-cinnabar-600 dark:text-cinnabar-400">{error}</p>
	{/if}

	<!-- 目录列表 -->
	<div
		class="scroll-thin h-52 overflow-y-auto rounded-default border border-subtle bg-surface-base p-1"
	>
		{#if !loading && entries.length === 0}
			<p class="px-2 py-1 text-2xs text-faint">空目录。</p>
		{:else}
			{#each entries as entry (entry.name)}
				<button
					type="button"
					class={[
						'flex h-6 w-full items-center gap-2 rounded-[3px] px-2 text-left text-xs',
						entry.type === 'dir'
							? 'text-normal hover:bg-surface-hover'
							: 'cursor-default text-faint hover:bg-transparent'
					]}
					onclick={() => entry.type === 'dir' && navigateTo(entry.name)}
				>
					<Icon
						name={entry.type === 'dir' ? 'folder' : 'file-text'}
						size={12}
						class="shrink-0 text-faint"
					/>
					<span class="truncate font-mono">{entry.name}</span>
					{#if entry.symlink}
						<span class="shrink-0 text-2xs text-faint">→</span>
					{/if}
				</button>
			{/each}
		{/if}
	</div>

	<div class="flex items-center gap-2 rounded-default border border-subtle px-2 py-1">
		<span class="text-2xs text-faint">当前目录(即工程根)</span>
		<span class="min-w-0 flex-1 truncate font-mono text-2xs text-normal">{selectedPath}</span>
	</div>
</div>
