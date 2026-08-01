<script lang="ts" module>
	import type { ChangeSetWire } from '@agent-gateway/shared';

	export type FileDiffChange = ChangeSetWire['files'][number];
	type DiffLine = FileDiffChange['hunks'][number]['lines'][number];

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
		file: FileDiffChange;
		maxHeight?: string;
	}

	let { file, maxHeight = '32rem' }: Props = $props();
</script>

<div class="scroll-thin overflow-auto font-mono text-xs leading-5" style:max-height={maxHeight}>
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
		<p class="px-3 py-2 text-faint">没有可显示的文本差异。</p>
	{/if}
	{#if file.truncation}
		<p class="border-t border-subtle px-3 py-2 text-status-waiting">
			差异过大，已截断{file.truncation.omittedLines ? ` ${file.truncation.omittedLines} 行` : ''}。
		</p>
	{/if}
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
