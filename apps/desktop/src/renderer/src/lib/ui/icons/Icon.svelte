<script lang="ts">
	/**
	 * 内联图标集。不引图标库 —— 这个应用需要的图标不到 20 个,一个 library
	 * 换来的是几百 KB 和一层抽象。
	 *
	 * 统一 14×14、1.5 描边、currentColor,这样图标在任何文字颜色下都协调。
	 */
	import { cx } from '$lib/shared/utils/cx';

	export type IconName =
		| 'folder'
		| 'server'
		| 'search'
		| 'plus'
		| 'close'
		| 'pin'
		| 'chevron-right'
		| 'chevron-down'
		| 'terminal'
		| 'git-branch'
		| 'file-text'
		| 'pencil'
		| 'trash'
		| 'refresh'
		| 'globe'
		| 'plug'
		| 'agent'
		| 'list'
		| 'message'
		| 'layers'
		| 'sun'
		| 'moon'
		| 'monitor'
		| 'settings'
		| 'command'
		| 'bell'
		| 'copy'
		| 'link'
		| 'check'
		| 'log'
		| 'download';

	interface Props {
		name: IconName;
		size?: number;
		class?: string;
	}

	let { name, size = 14, class: className }: Props = $props();

	// 单一 path 数据表。多段路径的图标用数组。
	const paths: Record<IconName, string[]> = {
		folder: [
			'M2 4.5A1.5 1.5 0 0 1 3.5 3h2.8l1.2 1.5h4A1.5 1.5 0 0 1 13 6v5a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 2 11z'
		],
		server: ['M2.5 3h9v3.5h-9z', 'M2.5 8.5h9V12h-9z', 'M4.5 4.75h.01', 'M4.5 10.25h.01'],
		search: ['M11.5 11.5 14 14', 'M6.75 11a4.25 4.25 0 1 0 0-8.5 4.25 4.25 0 0 0 0 8.5Z'],
		plus: ['M8 3.5v9', 'M3.5 8h9'],
		close: ['M4 4l8 8', 'M12 4l-8 8'],
		pin: ['M8 2v6', 'M5 8h6l-3 5z'],
		'chevron-right': ['M6 4l4 4-4 4'],
		'chevron-down': ['M4 6l4 4 4-4'],
		terminal: ['M4 6l2 2-2 2', 'M8.5 10.5h3.5'],
		'git-branch': [
			'M5 3.5v9',
			'M5 4.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
			'M5 13.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
			'M11 7.75a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
			'M11 7.5v.5A3 3 0 0 1 8 11H5'
		],
		'file-text': ['M4 2.5h5L12 5.5v8H4z', 'M6 8h4', 'M6 10.5h4'],
		pencil: ['M3 13l2.75-.75L13 5l-2-2-7.25 7.25z', 'M9.75 4.25l2 2'],
		refresh: ['M14.5 8a5.5 5.5 0 1 0 1 3', 'M14.5 3.5V8H10'],
		trash: ['M3 4h9', 'M6.5 4V2.75h2V4', 'M4.5 4l.5 8h4.5l.5-8', 'M7 6.5v3.5'],
		globe: [
			'M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z',
			'M2.5 8h11',
			'M8 2a9 9 0 0 1 0 12',
			'M8 2a9 9 0 0 0 0 12'
		],
		plug: ['M5 2.5v3', 'M11 2.5v3', 'M3.5 5.5h9v1A4.5 4.5 0 0 1 8 11v2.5'],
		agent: [
			'M5.5 5A2.5 2.5 0 1 1 8 7.5 2.5 2.5 0 0 1 5.5 5Z',
			'M2.5 13a5.5 5.5 0 0 1 11 0',
			'M12 3.5h2',
			'M13 2.5v2'
		],
		list: ['M3 4.5h.01', 'M3 8h.01', 'M3 11.5h.01', 'M5.5 4.5H13', 'M5.5 8H13', 'M5.5 11.5H13'],
		message: [
			'M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v5A1.5 1.5 0 0 1 12 10.5H6l-3.5 3z'
		],
		layers: ['M8 2 2.5 5 8 8l5.5-3z', 'M2.5 9.5 8 12.5l5.5-3'],
		sun: [
			'M8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z',
			'M8 1.5v1.5',
			'M8 13v1.5',
			'M1.5 8H3',
			'M13 8h1.5',
			'M3.4 3.4l1 1',
			'M11.6 11.6l1 1',
			'M12.6 3.4l-1 1',
			'M4.4 11.6l-1 1'
		],
		moon: ['M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z'],
		monitor: ['M2.5 3.5h11v7h-11z', 'M6 13h4', 'M8 10.5V13'],
		settings: [
			'M8 8m-4.8 0a4.8 4.8 0 1 0 9.6 0 4.8 4.8 0 1 0-9.6 0',
			'M12.8 8h1.1',
			'M3.2 8h-1.1',
			'M8 3.2v-1.1',
			'M8 12.8v1.1',
			'M11.39 11.39l.78.78',
			'M4.61 4.61l-.78-.78',
			'M4.61 11.39l-.78.78',
			'M11.39 4.61l.78-.78',
			'M8 8m-1.3 0a1.3 1.3 0 1 0 2.6 0 1.3 1.3 0 1 0-2.6 0'
		],
		command: [
			'M5.5 2.5A1.5 1.5 0 1 1 4 4v8a1.5 1.5 0 1 1 1.5-1.5h5A1.5 1.5 0 1 1 12 12V4a1.5 1.5 0 1 1-1.5 1.5h-5z'
		],
		bell: ['M3.5 11h9l-1-1.5V6a3.5 3.5 0 0 0-7 0v3.5z', 'M6.5 13a1.5 1.5 0 0 0 3 0'],
		copy: ['M5.5 5.5h7v7h-7z', 'M3.5 10.5h-1v-7h7v1'],
		link: [
			'M6.25 10.25 5 11.5a2.1 2.1 0 0 1-3-3l2-2a2.1 2.1 0 0 1 3 0',
			'M9.75 5.75 11 4.5a2.1 2.1 0 0 1 3 3l-2 2a2.1 2.1 0 0 1-3 0',
			'M5.75 10.25l4.5-4.5'
		],
		check: ['M3.5 8.5 6.5 11.5 12.5 4.5'],
		log: ['M3.5 4.5h9', 'M3.5 8h9', 'M3.5 11.5h6'],
		download: ['M8 3v7', 'M5.5 7.5 8 10l2.5-2.5', 'M3.5 13h9']
	};

	const d = $derived(paths[name] ?? []);
	// 实心填充的图标(pin / message 的气泡)描边与填充规则不同
	const filled = $derived(name === 'folder' || name === 'moon');
</script>

<svg
	viewBox="0 0 16 16"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width="1.4"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	class={cx('shrink-0', className)}
>
	{#each d as path (path)}
		<path d={path} fill={filled ? 'currentColor' : 'none'} fill-opacity={filled ? 0.12 : 0} />
	{/each}
</svg>
