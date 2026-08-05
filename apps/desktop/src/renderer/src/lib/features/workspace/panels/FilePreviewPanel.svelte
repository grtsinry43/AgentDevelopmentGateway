<script lang="ts">
	import { languages } from '@codemirror/language-data';
	import type { Extension } from '@codemirror/state';
	import { basename } from '$lib/shared/utils/path';
	import { filePreview, type FilePreviewRange } from '$lib/features/files/file-preview.svelte';
	import { fileIconKindForName } from '$lib/features/files/file-icons';
	import { highlightCode, languageFromPath } from '$lib/features/session/markdown/highlight';
	import '$lib/features/session/markdown/hljs-theme.css';
	import { keymap } from '$lib/shared/keymap/keymap.svelte';
	import { cx } from '$lib/shared/utils/cx';
	import Button from '$lib/ui/primitives/Button.svelte';
	import CodeEditor from '$lib/ui/editor/CodeEditor.svelte';
	import EmptyState from '$lib/ui/common/EmptyState.svelte';
	import FileIcon from '$lib/ui/icons/FileIcon.svelte';
	import Icon from '$lib/ui/icons/Icon.svelte';

	const path = $derived(filePreview.path);
	const status = $derived(filePreview.status);
	const content = $derived(filePreview.content);
	const error = $derived(filePreview.error);
	const range = $derived(filePreview.range);
	const editing = $derived(filePreview.editing);
	const saving = $derived(filePreview.saving);
	const canWrite = $derived(filePreview.canWrite);
	const language = $derived(path ? languageFromPath(path) : 'plaintext');
	const fileKind = $derived(path ? fileIconKindForName(path) : undefined);
	const lines = $derived(content === '' ? [] : content.split('\n'));
	const dirty = $derived(editing && filePreview.draft !== content);

	/** 编辑器的语法高亮:按文件名异步加载语言支持。 */
	let languageSupport = $state<Extension>([]);
	$effect(() => {
		if (!path || !editing) {
			languageSupport = [];
			return;
		}
		const description = languages.find(
			(entry) => entry.extensions.includes(extname(path)) || entry.filename?.test(path)
		);
		if (!description) {
			languageSupport = [];
			return;
		}
		let cancelled = false;
		void description
			.load()
			.then((support) => {
				if (!cancelled) languageSupport = [support];
			})
			.catch(() => {
				if (!cancelled) languageSupport = [];
			});
		return () => {
			cancelled = true;
		};
	});

	let panelRoot = $state<HTMLElement | undefined>();
	$effect(() =>
		keymap.pushScope('file-preview', [
			{
				keys: 'mod+s',
				label: '保存',
				when: () =>
					filePreview.editing &&
					!filePreview.saving &&
					panelRoot?.contains(document.activeElement as Node) === true,
				run: () => void filePreview.save()
			}
		])
	);

	/** 该行(1-based)是否落在打开时携带的行号区间内。 */
	function lineInRange(line: number, range: FilePreviewRange | null): boolean {
		if (!range) return false;
		if (range.startLine !== undefined && range.endLine !== undefined) {
			return line >= range.startLine && line <= range.endLine;
		}
		return range.line === line;
	}

	/** 提取扩展名(不含点);无扩展名返回空串。 */
	function extname(name: string): string {
		const base = basename(name);
		const dot = base.lastIndexOf('.');
		return dot > 0 ? base.slice(dot + 1) : '';
	}

	/** 滚动容器:打开后定位到区间首行。 */
	let scrollEl = $state<HTMLDivElement | undefined>();
	$effect(() => {
		if (!scrollEl || status !== 'ready' || !range) return;
		const start = range.startLine ?? range.line;
		if (start === undefined) return;
		const lineEl = scrollEl.querySelector(`[data-line="${start}"]`);
		lineEl?.scrollIntoView({ block: 'center' });
	});
</script>

{#if !path && status === 'idle'}
	<div class="h-full min-h-0">
		<EmptyState title="文件预览" description="从对话中的文件引用打开。" compact>
			{#snippet icon()}
				<Icon name="file-text" size={16} />
			{/snippet}
		</EmptyState>
	</div>
{:else}
	<div
		class="flex h-full min-h-0 flex-1 flex-col overflow-hidden"
		bind:this={panelRoot}
	>
		<div
			class="flex h-7 shrink-0 items-center gap-1.5 border-b border-subtle px-2 text-2xs text-muted"
		>
			<FileIcon kind={fileKind} size={12} class="shrink-0 text-faint" />
			<span class="min-w-0 flex-1 truncate font-mono" title={path ?? undefined}>{path}</span>
			{#if dirty}
				<span class="shrink-0 text-amber-500">未保存</span>
			{/if}
			{#if range && !editing}
				<span class="shrink-0 font-mono text-faint">
					{range.startLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.line}`}
				</span>
			{/if}
			{#if status === 'loading'}
				<span class="shrink-0 text-faint">读取中…</span>
			{/if}
			{#if status === 'ready' && !editing && canWrite}
				<Button
					size="sm"
					variant="ghost"
					class="h-5 px-1.5 text-2xs"
					title="编辑 (⌘E)"
					onclick={() => filePreview.startEditing()}
				>
					编辑
				</Button>
			{/if}
			{#if editing}
				<Button
					size="sm"
					variant="primary"
					class="h-5 px-1.5 text-2xs"
					disabled={saving || !dirty}
					title="保存 (⌘S)"
					onclick={() => void filePreview.save()}
				>
					{saving ? '保存中…' : '保存'}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					class="h-5 px-1.5 text-2xs"
					onclick={() => filePreview.cancelEditing()}
				>
					取消
				</Button>
			{/if}
			<button
				type="button"
				class="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-default text-faint hover:bg-surface-hover hover:text-normal"
				aria-label="关闭预览"
				onclick={() => filePreview.clear()}
			>
				<Icon name="close" size={12} />
			</button>
		</div>

		{#if filePreview.saveError}
			<p
				class="m-2 shrink-0 rounded-default bg-cinnabar-500/8 px-2 py-1.5 text-2xs text-status-error"
			>
				保存失败：{filePreview.saveError}
			</p>
		{/if}

		{#if status === 'error'}
			<p
				class="m-2 shrink-0 rounded-default bg-cinnabar-500/8 px-2 py-1.5 text-2xs text-status-error"
			>
				{error ?? '无法读取文件'}
			</p>
		{:else if status === 'loading'}
			<p class="shrink-0 px-2 py-2 text-2xs text-faint">正在读取文件…</p>
		{:else if editing}
			<div class="min-h-0 flex-1">
				<CodeEditor
					bind:value={filePreview.draft}
					appearance="bare"
					extensions={languageSupport}
					autofocus
					class="h-full"
				/>
			</div>
		{:else}
			<div
				class="agent-code scroll-thin min-h-0 flex-1 overflow-auto bg-surface-raised"
				bind:this={scrollEl}
			>
				<div class="min-w-max">
					{#each lines as line, index (index)}
						{@const lineNumber = index + 1}
						<div
							class={cx(
								'flex items-start whitespace-pre',
								lineInRange(lineNumber, range) && 'bg-jade-500/12'
							)}
							data-line={lineNumber}
						>
							<span
								class="w-10 shrink-0 pr-3 text-right font-mono text-2xs leading-5 text-faint select-none"
								>{lineNumber}</span
							>
							<code class={`hljs language-${language} font-mono text-xs leading-5 whitespace-pre`}>
								<!-- highlight.js escapes the source text before returning markup. -->
								<!-- eslint-disable-next-line svelte/no-at-html-tags -->
								{@html highlightCode(line, language)}
							</code>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
{/if}
