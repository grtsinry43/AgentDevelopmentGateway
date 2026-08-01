<script lang="ts" module>
	import type { ChangeSetWire } from '@agent-gateway/shared';

	type FileChange = ChangeSetWire['files'][number];
	type DiffLine = FileChange['hunks'][number]['lines'][number];

	const CHANGE_LABELS: Record<FileChange['kind'], string> = {
		create: '新增',
		modify: '修改',
		delete: '删除',
		rename: '重命名'
	};

	function lineMarker(line: DiffLine): string {
		if (line.kind === 'addition') return '+';
		if (line.kind === 'deletion') return '−';
		if (line.kind === 'no-newline') return '\\';
		return ' ';
	}

	function lineClass(line: DiffLine): string {
		if (line.kind === 'addition') return 'diff-line-addition';
		if (line.kind === 'deletion') return 'diff-line-deletion';
		if (line.kind === 'no-newline') return 'diff-line-note';
		return 'diff-line-context';
	}
</script>

<script lang="ts">
	interface Props {
		changeSet: ChangeSetWire;
	}

	let { changeSet }: Props = $props();
	const additions = $derived(changeSet.files.reduce((total, file) => total + file.additions, 0));
	const deletions = $derived(changeSet.files.reduce((total, file) => total + file.deletions, 0));
</script>

<div class="min-w-0 overflow-hidden rounded-default border border-subtle bg-surface-panel">
	<div class="flex h-8 items-center gap-2 border-b border-subtle px-2 text-2xs text-faint">
		{#if changeSet.files.length === 1}
			<code class="min-w-0 flex-1 truncate font-mono text-normal">
				{changeSet.files[0]?.previousPath ? `${changeSet.files[0]?.previousPath} → ` : ''}{changeSet
					.files[0]?.path}
			</code>
		{:else}
			<span class="flex-1">{changeSet.files.length} 个文件</span>
		{/if}
		<span class="font-mono text-status-completed">+{additions}</span>
		<span class="font-mono text-status-error">−{deletions}</span>
		<span>{changeSet.intent === 'proposed' ? '待审批' : '已应用'}</span>
	</div>

	{#each changeSet.files as file, fileIndex (`${file.path}:${fileIndex}`)}
		<details
			class="group/file border-b border-subtle last:border-b-0"
			open={changeSet.files.length === 1}
		>
			<summary
				class="flex h-8 cursor-pointer list-none items-center gap-1.5 px-2 text-xs marker:hidden hover:bg-surface-hover data-[single=true]:hidden"
				data-single={changeSet.files.length === 1}
			>
				<span
					class="text-2xs text-faint transition-transform group-open/file:rotate-90"
					aria-hidden="true">▶</span
				>
				<span class="shrink-0 text-2xs text-muted">{CHANGE_LABELS[file.kind]}</span>
				<code class="min-w-0 flex-1 truncate font-mono text-normal">
					{file.previousPath ? `${file.previousPath} → ` : ''}{file.path}
				</code>
				{#if file.pathKind === 'absolute'}
					<span class="shrink-0 text-2xs text-status-waiting">工作区外</span>
				{/if}
				<span class="shrink-0 font-mono text-2xs text-status-completed">+{file.additions}</span>
				<span class="shrink-0 font-mono text-2xs text-status-error">−{file.deletions}</span>
			</summary>

			<div
				class="scroll-thin max-h-[32rem] overflow-auto border-t border-subtle font-mono text-xs leading-5"
			>
				{#if file.binary}
					<p class="px-3 py-2 text-faint">二进制文件发生变化，无法显示文本差异。</p>
				{:else if file.hunks.length > 0}
					{#each file.hunks as hunk, hunkIndex (`${hunk.oldStart}:${hunk.newStart}:${hunkIndex}`)}
						<div
							class="sticky top-0 z-10 border-y border-subtle bg-surface-raised px-3 py-1 text-2xs text-accent first:border-t-0"
						>
							@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.heading
								? ` ${hunk.heading}`
								: ''}
						</div>
						{#each hunk.lines as line, lineIndex (lineIndex)}
							<div
								class={`diff-line grid min-w-max grid-cols-[3rem_3rem_1.25rem_minmax(20rem,1fr)] ${lineClass(line)}`}
							>
								<span class="diff-line-number">{line.oldLine ?? ''}</span>
								<span class="diff-line-number">{line.newLine ?? ''}</span>
								<span class="text-center select-none">{lineMarker(line)}</span>
								<span class="pr-4 whitespace-pre">{line.text || ' '}</span>
							</div>
						{/each}
					{/each}
				{:else if file.patch}
					<pre class="min-w-max px-3 py-2 whitespace-pre text-normal">{file.patch}</pre>
				{:else}
					<p class="px-3 py-2 text-faint">运行时只报告了文件变化，没有提供文本 patch。</p>
				{/if}
				{#if file.truncation}
					<p class="border-t border-subtle px-3 py-2 text-status-waiting">
						差异过大，已截断{file.truncation.omittedLines
							? ` ${file.truncation.omittedLines} 行`
							: ''}。
					</p>
				{/if}
			</div>
		</details>
	{/each}
</div>

<style>
	.diff-line {
		color: var(--text-normal);
	}

	.diff-line-number {
		padding-right: 0.5rem;
		border-right: 1px solid var(--border-subtle);
		color: var(--text-faint);
		text-align: right;
		user-select: none;
	}

	.diff-line-addition {
		background: color-mix(in srgb, var(--status-completed) 11%, transparent);
	}

	.diff-line-addition > :nth-child(3) {
		color: var(--status-completed);
	}

	.diff-line-deletion {
		background: color-mix(in srgb, var(--status-error) 10%, transparent);
	}

	.diff-line-deletion > :nth-child(3) {
		color: var(--status-error);
	}

	.diff-line-note {
		color: var(--text-faint);
		font-style: italic;
	}
</style>
