<script lang="ts">
	import { onMount } from 'svelte';
	import { FitAddon } from '@xterm/addon-fit';
	import { Terminal as XtermTerminal, type IDisposable } from '@xterm/xterm';
	import '@xterm/xterm/css/xterm.css';
	import type { TerminalDescriptor, TerminalServerMessage } from '@agent-gateway/shared';
	import { desktop } from '$lib/shared/bridge/desktop';
	import { pushBus } from '$lib/shared/bridge/events';
	import { theme } from '$lib/shared/theme/theme.svelte';

	const TERMINAL_FONT_FAMILY =
		'"VictorMono Nerd Font Mono Embedded", "Victor Mono Variable", ui-monospace, SFMono-Regular, monospace';
	const TERMINAL_FONT_SPEC = '400 11px "VictorMono Nerd Font Mono Embedded"';

	interface Props {
		terminal: TerminalDescriptor;
		active: boolean;
	}

	let { terminal: descriptor, active }: Props = $props();
	let container = $state<HTMLElement | null>(null);
	let emulator: XtermTerminal | undefined;
	let fitAddon: FitAddon | undefined;
	let inputDisposable: IDisposable | undefined;
	let resizeObserver: ResizeObserver | undefined;
	let streamState = $state<'connecting' | 'connected' | 'retrying' | 'closed' | 'error'>(
		'connecting'
	);
	let streamMessage = $state<string | undefined>(undefined);
	let processExited = $state(false);
	let highestScheduledSequence: number | undefined;
	let generation = 0;
	let attached = false;
	let lastCols = 80;
	let lastRows = 24;

	onMount(() => {
		if (!container) return;
		let disposed = false;

		const unsubscribeMessage = pushBus.on('terminal.message', (event) => {
			if (event.terminalId === descriptor.id) handleMessage(event.message);
		});
		const unsubscribeStream = pushBus.on('terminal.stream', (event) => {
			if (event.terminalId !== descriptor.id) return;
			streamState = event.state;
			streamMessage = event.message;
		});

		void initialize();

		async function initialize(): Promise<void> {
			try {
				await document.fonts.load(TERMINAL_FONT_SPEC);
			} catch {
				// The existing bundled Victor Mono remains a usable fallback.
			}
			if (disposed || !container) return;

			lastCols = descriptor.cols;
			lastRows = descriptor.rows;
			createEmulator(descriptor.cols, descriptor.rows);
			if (active) fitLocally();

			try {
				await desktop.terminals.attach(descriptor.id, undefined, lastCols, lastRows);
				if (disposed) return;
				attached = true;
			} catch (error) {
				if (disposed) return;
				streamState = 'error';
				streamMessage = errorMessage(error);
			}

			resizeObserver = new ResizeObserver(() => {
				if (!active) return;
				requestAnimationFrame(() => resizeToContainer());
			});
			resizeObserver.observe(container);
		}

		return () => {
			disposed = true;
			unsubscribeMessage();
			unsubscribeStream();
			resizeObserver?.disconnect();
			inputDisposable?.dispose();
			emulator?.dispose();
			void desktop.terminals.detach(descriptor.id);
		};
	});

	$effect(() => {
		if (!active) return;
		queueMicrotask(() => resizeToContainer());
	});

	$effect(() => {
		if (emulator) emulator.options.theme = terminalTheme(theme.resolved);
	});

	function createEmulator(cols: number, rows: number): void {
		if (!container) return;
		generation += 1;
		inputDisposable?.dispose();
		emulator?.dispose();
		// xterm exclusively owns descendants of this host; Svelte never renders into it.
		// eslint-disable-next-line svelte/no-dom-manipulating
		container.replaceChildren();

		const next = new XtermTerminal({
			cols,
			rows,
			cursorBlink: true,
			cursorStyle: 'bar',
			fontFamily: TERMINAL_FONT_FAMILY,
			fontSize: 11,
			lineHeight: 1.25,
			scrollback: 10_000,
			allowTransparency: true,
			theme: terminalTheme()
		});
		const nextFit = new FitAddon();
		next.loadAddon(nextFit);
		next.open(container);
		inputDisposable = next.onData((data) => {
			void desktop.terminals.input(descriptor.id, data).catch((error: unknown) => {
				streamState = 'error';
				streamMessage = errorMessage(error);
			});
		});
		emulator = next;
		fitAddon = nextFit;
		lastCols = cols;
		lastRows = rows;
	}

	function handleMessage(message: TerminalServerMessage): void {
		switch (message.type) {
			case 'terminal.snapshot':
				applySnapshot(message);
				break;
			case 'terminal.ready':
				highestScheduledSequence = message.sequence;
				break;
			case 'terminal.output':
				applyOutput(message);
				break;
			case 'terminal.exit':
				processExited = true;
				streamState = 'closed';
				streamMessage = `进程已退出 (${message.exitCode ?? message.signal ?? 'unknown'})`;
				break;
			case 'terminal.error':
				streamState = 'error';
				streamMessage = message.message;
				break;
		}
	}

	function applySnapshot(
		message: Extract<TerminalServerMessage, { type: 'terminal.snapshot' }>
	): void {
		createEmulator(message.terminal.cols, message.terminal.rows);
		highestScheduledSequence = message.sequence;
		const target = emulator;
		const writeGeneration = generation;
		if (!target) return;
		target.write(message.data, () => {
			if (generation !== writeGeneration) return;
			acknowledge(message.sequence);
			if (active) resizeToContainer();
		});
	}

	function applyOutput(message: Extract<TerminalServerMessage, { type: 'terminal.output' }>): void {
		const target = emulator;
		if (!target) return;
		if (highestScheduledSequence !== undefined && message.sequence <= highestScheduledSequence) {
			return;
		}
		if (
			highestScheduledSequence !== undefined &&
			message.sequence !== highestScheduledSequence + 1
		) {
			streamState = 'error';
			streamMessage = `终端输出序列不连续：期望 ${highestScheduledSequence + 1}，收到 ${message.sequence}`;
			return;
		}
		highestScheduledSequence = message.sequence;
		const writeGeneration = generation;
		target.write(message.data, () => {
			if (generation === writeGeneration) acknowledge(message.sequence);
		});
	}

	function acknowledge(sequence: number): void {
		void desktop.terminals.acknowledge(descriptor.id, sequence).catch((error: unknown) => {
			streamState = 'error';
			streamMessage = errorMessage(error);
		});
	}

	function retry(): void {
		streamState = 'connecting';
		streamMessage = undefined;
		void desktop.terminals.retry(descriptor.id).catch((error: unknown) => {
			streamState = 'error';
			streamMessage = errorMessage(error);
		});
	}

	function fitLocally(): void {
		const dimensions = fitAddon?.proposeDimensions();
		if (!dimensions || dimensions.cols < 2 || dimensions.rows < 1) return;
		fitAddon?.fit();
		lastCols = dimensions.cols;
		lastRows = dimensions.rows;
	}

	function resizeToContainer(): void {
		if (!active || !emulator || !fitAddon || !container?.isConnected) return;
		const dimensions = fitAddon.proposeDimensions();
		if (!dimensions || dimensions.cols < 2 || dimensions.rows < 1) return;
		if (dimensions.cols === lastCols && dimensions.rows === lastRows) return;
		fitAddon.fit();
		lastCols = dimensions.cols;
		lastRows = dimensions.rows;
		if (attached) {
			void desktop.terminals.resize(descriptor.id, lastCols, lastRows).catch((error: unknown) => {
				streamState = 'error';
				streamMessage = errorMessage(error);
			});
		}
	}

	function terminalTheme(
		resolvedTheme: 'light' | 'dark' = theme.resolved
	): NonNullable<XtermTerminal['options']['theme']> {
		const styles = getComputedStyle(document.documentElement);
		const dark = resolvedTheme === 'dark';
		const value = (name: string, fallback: string): string =>
			styles.getPropertyValue(name).trim() || fallback;
		return {
			background: '#00000000',
			foreground: value('--text-normal', dark ? '#d6d3d1' : '#44403c'),
			cursor: value('--text-accent', '#2dd4bf'),
			selectionBackground: value('--surface-active', '#ffffff18'),
			black: dark ? '#1c1917' : '#292524',
			red: '#ef4444',
			green: '#14b8a6',
			yellow: '#eab308',
			blue: '#60a5fa',
			magenta: '#c084fc',
			cyan: '#2dd4bf',
			white: '#e7e5e4'
		};
	}

	function errorMessage(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}
</script>

<div class:hidden={!active} class="relative h-full min-h-0 overflow-hidden bg-surface-panel">
	<div bind:this={container} class="terminal-host h-full min-h-0"></div>
	{#if streamState !== 'connected'}
		<div
			class="absolute right-2 bottom-1.5 flex max-w-[80%] items-center gap-1 rounded-default bg-surface-overlay px-1.5 py-0.5 text-2xs text-muted backdrop-blur-sm"
			title={streamMessage}
		>
			<span class="truncate">
				{streamState === 'connecting'
					? '连接中…'
					: streamState === 'retrying'
						? '重新连接中…'
						: (streamMessage ?? '终端已断开')}
			</span>
			{#if !processExited && (streamState === 'closed' || streamState === 'error')}
				<button type="button" class="shrink-0 text-accent hover:underline" onclick={retry}
					>重试</button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.terminal-host :global(.xterm) {
		height: 100%;
	}

	.terminal-host :global(.xterm-viewport) {
		background: transparent !important;
	}
</style>
