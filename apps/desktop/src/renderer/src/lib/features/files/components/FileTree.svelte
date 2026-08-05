<script lang="ts">
	import { createVirtualizer, type SvelteVirtualizer } from '@tanstack/svelte-virtual';
	import { normalizeProps, useMachine } from '@zag-js/svelte';
	import * as tree from '@zag-js/tree-view';
	import type { Unsubscriber } from 'svelte/store';
	import FileTreeRow from '$lib/features/files/components/FileTreeRow.svelte';
	import { FileTreeWorkspace, type FileTreeNode } from '$lib/features/files/file-tree.svelte';
	import { fileApi } from '$lib/features/files/api';
	import { filePreview } from '$lib/features/files/file-preview.svelte';
	import { sessionWorkspace } from '$lib/features/session/session-workspace.svelte';
	import { requireProjectIdentity } from '$lib/shared/bridge/desktop';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { notifications } from '$lib/shared/notifications/notifications.svelte';
	import Button from '$lib/ui/primitives/Button.svelte';
	import ContextMenu, { type ContextMenuItem } from '$lib/ui/primitives/ContextMenu.svelte';
	import Dialog from '$lib/ui/primitives/Dialog.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';
	import Input from '$lib/ui/primitives/Input.svelte';
	import Spinner from '$lib/ui/primitives/Spinner.svelte';

	interface Props {
		projectKey: string;
	}

	type TreeEditorState =
		| { mode: 'rename'; node: FileTreeNode; value: string }
		| { mode: 'create'; parentPath: string; kind: 'file' | 'directory'; value: string };

	let { projectKey }: Props = $props();
	const workspace = $derived(new FileTreeWorkspace(projectKey));
	/** 远程主机:右键「下载到本地」;本地主机:「在系统文件管理器中打开」。 */
	const remoteHost = $derived(requireProjectIdentity().hostType === 'ssh');
	let scrollElement = $state<HTMLDivElement>();
	let treeRoot = $state<HTMLElement | undefined>();
	let virtualizerInstance: SvelteVirtualizer<HTMLDivElement, HTMLDivElement> | undefined;
	let stopVirtualizer: Unsubscriber | undefined;

	let menu = $state<{ x: number; y: number; node: FileTreeNode } | undefined>(undefined);
	let editor = $state<TreeEditorState | undefined>(undefined);
	let editorInput = $state<HTMLInputElement | null>(null);
	let editorRect = $state({ top: 0, left: 0, width: 0 });
	let pendingDelete = $state<FileTreeNode | undefined>(undefined);
	let deleteOpen = $state(false);
	let dragSource = $state<FileTreeNode | undefined>(undefined);
	let dropTargetPath = $state<string | undefined>(undefined);

	const collection = $derived(
		tree.collection<FileTreeNode>({
			rootNode: workspace.rootNode,
			nodeToValue: (node) => node.path,
			nodeToString: (node) => node.name,
			nodeToChildren: (node) => node.children ?? [],
			nodeToChildrenCount: (node) =>
				node.kind === 'directory' ? (node.children?.length ?? 0) : undefined
		})
	);

	const service = useMachine(tree.machine as tree.Machine<FileTreeNode>, () => ({
		id: `workspace-files-${projectKey}`,
		collection,
		selectionMode: 'single' as const,
		translations: { treeLabel: '工程文件' },
		loadChildren: ({ node, signal }) => workspace.loadChildren(node, signal),
		onExpandedChange: (details) => void workspace.setExpanded(details.expandedNodes),
		onSelectionChange: (details) => workspace.select(details.selectedNodes[0]?.path),
		onLoadChildrenError: (details) => {
			workspace.error = details.nodes[0]?.error.message ?? '目录加载失败';
		},
		scrollToIndexFn: ({ index }) => virtualizerInstance?.scrollToIndex(index, { align: 'auto' })
	}));
	const api = $derived(tree.connect(service, normalizeProps));
	const visibleNodes = $derived(api.getVisibleNodes());

	const virtualizerStore = createVirtualizer<HTMLDivElement, HTMLDivElement>({
		count: 0,
		getScrollElement: () => scrollElement ?? null,
		estimateSize: () => 22,
		overscan: 8
	});

	$effect(() => workspace.start());

	$effect(() => {
		stopVirtualizer = virtualizerStore.subscribe((instance) => {
			virtualizerInstance = instance;
		});
		return () => stopVirtualizer?.();
	});

	$effect(() => {
		const count = visibleNodes.length;
		virtualizerInstance?.setOptions({
			count,
			getScrollElement: () => scrollElement ?? null,
			getItemKey: (index) => visibleNodes[index]?.node.path ?? index
		});
	});

	$effect(() => {
		const detail = workspace.streamMessage;
		if (detail) {
			notifications.notify({
				key: `files-stream:${projectKey}`,
				severity: workspace.streamState === 'error' ? 'error' : 'warning',
				title: '文件树同步异常',
				summary: '正在后台重新连接文件事件流',
				detail
			});
		} else if (workspace.streamState === 'connected' || workspace.streamState === 'closed') {
			notifications.resolve(`files-stream:${projectKey}`);
		}
	});

	$effect(() => {
		if (editor && editorInput) {
			editorInput.focus();
			if (editor.mode === 'rename') editorInput.select();
		}
	});

	$effect(() => {
		if (!editor) return;
		const anchor = anchorElement(editor);
		if (!anchor) return;
		const containerRect = scrollElement?.getBoundingClientRect();
		if (!containerRect) return;
		const rect = anchor.getBoundingClientRect();
		editorRect = {
			top: rect.top - containerRect.top,
			left: rect.left - containerRect.left,
			width: rect.width
		};
	});

	$effect(() => {
		if (!deleteOpen) pendingDelete = undefined;
	});

	function anchorElement(state: TreeEditorState): HTMLElement | null | undefined {
		const anchorPath =
			state.mode === 'rename' ? state.node.path : state.parentPath || '__workspace_root__';
		if (state.mode === 'create' && state.parentPath === '') return scrollElement;
		return scrollElement?.querySelector<HTMLElement>(
			`[data-tree-path="${CSS.escape(anchorPath)}"]`
		);
	}

	function openMenu(event: MouseEvent, node: FileTreeNode): void {
		event.preventDefault();
		event.stopPropagation();
		menu = { x: event.clientX, y: event.clientY, node };
	}

	function beginRename(node: FileTreeNode): void {
		menu = undefined;
		editor = { mode: 'rename', node, value: node.name };
	}

	function beginCreate(parentPath: string, kind: 'file' | 'directory'): void {
		menu = undefined;
		editor = { mode: 'create', parentPath, kind, value: '' };
	}

	function beginCreateAtSelection(): void {
		const selected = findNode(workspace.selectedPath);
		const parent = selected?.kind === 'directory' ? selected.path : '';
		beginCreate(parent, 'file');
	}

	function commitEditor(): void {
		const target = editor;
		if (!target) return;
		editor = undefined;
		const name = target.value.trim();
		if (!name) return;
		void runMutation(() => {
			if (target.mode === 'rename') {
				const node = target.node;
				const parent = parentOfPath(node.path);
				return workspace.renameEntry(node, parent ? `${parent}/${name}` : name);
			}
			return workspace.createEntry(target.parentPath, name, target.kind);
		});
	}

	function cancelEditor(): void {
		editor = undefined;
	}

	function onEditorKeydown(event: KeyboardEvent): void {
		event.stopPropagation();
		if (event.key === 'Enter') commitEditor();
		else if (event.key === 'Escape') cancelEditor();
	}

	function requestDelete(node: FileTreeNode): void {
		menu = undefined;
		pendingDelete = node;
		deleteOpen = true;
	}

	function confirmDelete(): void {
		const node = pendingDelete;
		deleteOpen = false;
		pendingDelete = undefined;
		if (node) void runMutation(() => workspace.deleteEntry(node));
	}

	async function runMutation(operation: () => Promise<void>): Promise<void> {
		try {
			await operation();
		} catch (error) {
			notifications.notify({
				key: `files-mutation:${projectKey}`,
				severity: 'error',
				title: '文件操作失败',
				summary: errorMessage(error)
			});
		}
	}

	function reveal(node: FileTreeNode): void {
		menu = undefined;
		void (async () => {
			try {
				const downloaded = await fileApi.reveal(projectKey, node.path, node.kind);
				if (downloaded) {
					notifications.notify({
						key: `files-download:${projectKey}:${node.path}`,
						severity: 'info',
						title: '已下载到本地',
						summary: downloaded
					});
				}
			} catch (error) {
				notifications.notify({
					key: `files-reveal:${projectKey}`,
					severity: 'error',
					title: '操作失败',
					summary: errorMessage(error)
				});
			}
		})();
	}

	function handleDragStart(event: DragEvent, node: FileTreeNode): void {
		dragSource = node;
		dropTargetPath = undefined;
		event.dataTransfer?.setData('application/x-gateway-tree-path', node.path);
		if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
	}

	function handleDragEnd(): void {
		dragSource = undefined;
		dropTargetPath = undefined;
	}

	function handleDragOver(node: FileTreeNode): void {
		const source = dragSource;
		if (
			!source ||
			node.kind !== 'directory' ||
			source.path === node.path ||
			source.path.startsWith(`${node.path}/`) ||
			parentOfPath(source.path) === node.path
		) {
			dropTargetPath = undefined;
			return;
		}
		dropTargetPath = node.path;
	}

	function handleDrop(event: DragEvent, node: FileTreeNode): void {
		const source = dragSource;
		if (
			!source ||
			node.kind !== 'directory' ||
			source.path === node.path ||
			source.path.startsWith(`${node.path}/`)
		) {
			return;
		}
		void runMutation(() => workspace.moveEntry(source, node.path));
	}

	function findNode(path: string | undefined): FileTreeNode | undefined {
		if (!path) return undefined;
		const walk = (nodes: FileTreeNode[]): FileTreeNode | undefined => {
			for (const node of nodes) {
				if (node.path === path) return node;
				if (node.children) {
					const found = walk(node.children);
					if (found) return found;
				}
			}
			return undefined;
		};
		return walk(workspace.rootNode.children ?? []);
	}

	const menuItems = $derived.by<ContextMenuItem[]>(() => {
		const target = menu;
		if (!target) return [];
		const node = target.node;
		const items: ContextMenuItem[] = [];
		if (workspace.canWrite) {
			if (node.kind === 'directory') {
				items.push({
					label: '新建文件',
					icon: 'plus',
					run: () => beginCreate(node.path, 'file')
				});
				items.push({
					label: '新建文件夹',
					icon: 'folder',
					run: () => beginCreate(node.path, 'directory')
				});
			}
			items.push({
				label: '复制',
				icon: 'copy',
				run: () => {
					menu = undefined;
					workspace.copyNode(node);
				}
			});
			items.push({
				label: '剪切',
				icon: 'scissors',
				run: () => {
					menu = undefined;
					workspace.cutNode(node);
				}
			});
			items.push({
				label: '粘贴',
				icon: 'clipboard',
				disabled: !workspace.clipboard,
				run: () => {
					menu = undefined;
					void pasteIntoDirectory(directoryTargetOf(node));
				}
			});
			items.push({
				label: '重命名',
				icon: 'pencil',
				run: () => beginRename(node)
			});
			items.push({
				label: '删除',
				icon: 'trash',
				danger: true,
				run: () => requestDelete(node)
			});
		}
		items.push(
			{
				label: '复制相对路径',
				icon: 'file-text',
				run: () => {
					menu = undefined;
					void runMutation(() => workspace.copyPathText(node, 'relative'));
				}
			},
			{
				label: '复制绝对路径',
				icon: 'link',
				run: () => {
					menu = undefined;
					void runMutation(() => workspace.copyPathText(node, 'absolute'));
				}
			},
			{
				label: '引用到对话',
				icon: 'message',
				disabled: !sessionWorkspace.selectedSession,
				run: () => {
					menu = undefined;
					sessionWorkspace.referenceFile(node.path);
				}
			},
			{
				label: remoteHost ? '下载到本地' : '在系统文件管理器中打开',
				icon: remoteHost ? 'download' : 'globe',
				run: () => reveal(node)
			}
		);
		return items;
	});

	function parentOfPath(path: string): string {
		const index = path.lastIndexOf('/');
		return index === -1 ? '' : path.slice(0, index);
	}

	function basenameOfPath(path: string): string {
		const index = path.lastIndexOf('/');
		return index === -1 ? path : path.slice(index + 1);
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : '文件树操作失败';
	}

	/** 粘贴目标目录:节点是目录用它自己,是文件用其父目录,否则根目录。 */
	function directoryTargetOf(node: FileTreeNode): string {
		return node.kind === 'directory' ? node.path : parentOfPath(node.path);
	}

	async function pasteIntoDirectory(directory: string): Promise<void> {
		try {
			const created = await workspace.pasteInto(directory);
			if (created) beginRenamePath(created);
		} catch (error) {
			notifications.notify({
				key: `files-paste:${projectKey}`,
				severity: 'error',
				title: '粘贴失败',
				summary: errorMessage(error)
			});
		}
	}

	/** 粘贴/复制后进入重命名状态(VSCode 体验:副本名直接可改)。 */
	function beginRenamePath(path: string): void {
		editor = {
			mode: 'rename',
			node: { name: basenameOfPath(path), path, kind: 'file', generated: false },
			value: basenameOfPath(path)
		};
	}

	/** 焦点是否在文件树内且不在文本输入里(用于 ⌘C/X/V 门控)。 */
	function treeHasClipboardFocus(): boolean {
		const active = document.activeElement;
		const inTree = treeRoot !== undefined && active instanceof Node && treeRoot.contains(active);
		if (!inTree) return false;
		if (!(active instanceof HTMLElement)) return true;
		return !(active.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName));
	}

	function selectedClipboardNode(): FileTreeNode | undefined {
		return treeHasClipboardFocus() ? findNode(workspace.selectedPath) : undefined;
	}

	function pasteTargetDirectory(): string | undefined {
		if (!treeHasClipboardFocus()) return undefined;
		const selected = findNode(workspace.selectedPath);
		return selected ? (selected.kind === 'directory' ? selected.path : parentOfPath(selected.path)) : '';
	}

	// 复制/剪切/粘贴快捷键:只在文件树聚焦且有选中/剪贴板时接管,输入框内让位给原生剪贴板。
	$effect(() =>
		keymap.pushScope(`workspace-files:${projectKey}`, [
			{
				keys: 'mod+c',
				label: '',
				when: () => selectedClipboardNode() !== undefined,
				run: () => {
					const node = selectedClipboardNode();
					if (node) workspace.copyNode(node);
				}
			},
			{
				keys: 'mod+x',
				label: '',
				when: () => selectedClipboardNode() !== undefined,
				run: () => {
					const node = selectedClipboardNode();
					if (node) workspace.cutNode(node);
				}
			},
			{
				keys: 'mod+v',
				label: '',
				when: () => workspace.clipboard !== undefined && pasteTargetDirectory() !== undefined,
				run: () => {
					const directory = pasteTargetDirectory();
					if (directory !== undefined) void pasteIntoDirectory(directory);
				}
			}
		])
	);
</script>

{#if workspace.status === 'loading'}
	<div class="grid min-h-24 flex-1 place-items-center text-faint">
		<Spinner label="加载文件树" />
	</div>
{:else if workspace.status === 'unavailable'}
	<EmptyState
		title="文件服务不可用"
		description="当前 Gateway Server 未提供文件枚举与监听能力。"
		compact
	/>
{:else if workspace.status === 'error'}
	<EmptyState title="文件树加载失败" description={workspace.error ?? '无法读取工程目录。'} compact>
		{#snippet action()}
			<Button size="sm" variant="ghost" onclick={() => void workspace.retry()}>重试</Button>
		{/snippet}
	</EmptyState>
{:else}
	<section
		{...api.getRootProps()}
		bind:this={treeRoot}
		tabindex="-1"
		class="flex min-h-0 flex-1 flex-col outline-none"
		onpointerdown={(event) => {
			const target = event.target;
			if (target instanceof HTMLElement && target.closest('input,textarea,select,[contenteditable]')) {
				return;
			}
			treeRoot?.focus();
		}}
	>
		<div class="flex h-6 shrink-0 items-center gap-2 border-b border-subtle px-2">
			<span class="mr-auto text-2xs tracking-wide text-faint uppercase">Explorer</span>
			{#if workspace.streamState === 'connecting' || workspace.streamState === 'retrying'}
				<Spinner size="sm" label="同步文件变化" class="text-amber-500" />
			{/if}
			{#if workspace.canWrite}
				<Button
					size="sm"
					variant="icon"
					class="h-5 w-5"
					title="新建文件(在当前选中目录)"
					onclick={beginCreateAtSelection}
				>
					{#snippet icon()}
						<Icon name="plus" size={11} />
					{/snippet}
				</Button>
			{/if}
			<Button
				size="sm"
				variant="ghost"
				class="h-5 px-1.5 text-2xs"
				onclick={() => void workspace.refresh()}
			>
				刷新
			</Button>
		</div>

		{#if workspace.error}
			<div
				class="flex shrink-0 items-center gap-2 border-b border-cinnabar-500/20 px-2 py-1 text-2xs text-cinnabar-500"
			>
				<span class="min-w-0 flex-1 truncate" title={workspace.error}>{workspace.error}</span>
				<button type="button" class="hover:text-strong" onclick={() => void workspace.refresh()}
					>重试</button
				>
			</div>
		{/if}

		<div
			bind:this={scrollElement}
			class="scroll-thin relative min-h-0 flex-1 overflow-auto"
			role="group"
			ondragover={(event) => {
				if (event.target === event.currentTarget) dropTargetPath = undefined;
			}}
		>
			{#if visibleNodes.length === 0}
				<div class="grid h-20 place-items-center text-2xs text-faint">目录为空</div>
			{/if}
			<div
				{...api.getTreeProps()}
				class="relative min-w-max outline-none"
				style:height={`${$virtualizerStore.getTotalSize()}px`}
			>
				{#each $virtualizerStore.getVirtualItems() as virtualRow (visibleNodes[virtualRow.index]?.node.path)}
					{@const visible = visibleNodes[virtualRow.index]}
					{#if visible}
						<div
							role="presentation"
							class="absolute top-0 left-0 w-full"
							style:height={`${virtualRow.size}px`}
							style:transform={`translateY(${virtualRow.start}px)`}
						>
							<FileTreeRow
								{service}
								{visible}
								draggableEnabled={workspace.canWrite}
								draggedPath={dragSource?.path}
								dropTargetPath={dropTargetPath}
								oncontextmenu={openMenu}
								onopen={(node) => void filePreview.open(node.path)}
								ondragstart={handleDragStart}
								ondragend={handleDragEnd}
								ondragover={(_event, node) => handleDragOver(node)}
								ondrop={handleDrop}
							/>
						</div>
					{/if}
				{/each}
			</div>

			{#if editor}
				<div
					class="tree-editor absolute z-20"
					style:top="{editorRect.top}px"
					style:left="{editorRect.left}px"
					style:width="{editorRect.width}px"
				>
					<Input
						type="text"
						element={editorInput}
						bind:value={editor.value}
						placeholder={editor.mode === 'rename' ? '新名称(可含目录以移动)' : '名称'}
						onkeydown={onEditorKeydown}
						class="h-[22px] w-full text-xs"
					/>
				</div>
			{/if}
		</div>
	</section>
{/if}

{#if menu}
	<ContextMenu x={menu.x} y={menu.y} items={menuItems} onclose={() => (menu = undefined)} />
{/if}

<Dialog bind:open={deleteOpen} title="删除文件" description={pendingDelete?.path} width="max-w-sm">
	<p class="text-xs text-muted">
		{pendingDelete?.kind === 'directory'
			? '将删除该文件夹及其所有内容。'
			: '将删除该文件。'}
		此操作不可撤销。
	</p>
	{#snippet footer()}
		<Button variant="ghost" onclick={() => (deleteOpen = false)}>取消</Button>
		<Button variant="danger" onclick={confirmDelete}>删除</Button>
	{/snippet}
</Dialog>

<style>
	.tree-editor :global(input) {
		box-shadow: inset 0 0 0 1px var(--line-accent);
		border-radius: 3px;
		background: var(--surface-raised);
	}
</style>
