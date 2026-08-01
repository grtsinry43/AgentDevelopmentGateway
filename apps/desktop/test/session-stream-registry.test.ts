import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEventWire } from '@agent-gateway/shared';
import type { PushEvent } from '../src/contract/bridge.js';
import {
	SessionStreamRegistry,
	type SessionStreamClient,
	type StreamContents
} from '../src/main/server/session-stream-registry.js';

test('treats a terminal Session EOF as closed instead of retrying', async () => {
	const client: SessionStreamClient = {
		session: async () => ({ status: 'closed' }),
		events: async function* () {
			yield* [] as RuntimeEventWire[];
		}
	};
	const contents = new FakeContents();
	const registry = createRegistry(client);

	registry.watch(contents, 'terminal-session', 12);

	await contents.waitFor((event) => event.kind === 'session.stream' && event.state === 'closed');
	assert.equal(
		contents.events.some((event) => event.kind === 'session.stream' && event.state === 'retrying'),
		false
	);
});

test('switches from fast retries to background retries without stopping', async () => {
	let calls = 0;
	const client: SessionStreamClient = {
		session: async () => ({ status: 'running' }),
		events: async function* () {
			calls += 1;
			yield* [] as RuntimeEventWire[];
			throw new Error('offline');
		}
	};
	const contents = new FakeContents();
	const registry = createRegistry(client);

	registry.watch(contents, 'reconnecting-session', 0);

	const slowRetry = await contents.waitFor(
		(event) => event.kind === 'session.stream' && event.state === 'retrying' && event.attempt === 3
	);
	assert.equal(calls >= 3, true);
	assert.equal(slowRetry.kind, 'session.stream');
	if (slowRetry.kind === 'session.stream') {
		assert.match(slowRetry.message ?? '', /后台继续重连/);
	}
	registry.unwatch(contents, 'reconnecting-session');
});

test('resumes from the latest cursor and activity resets the retry budget', async () => {
	const cursors: number[] = [];
	let calls = 0;
	const client: SessionStreamClient = {
		session: async () => ({ status: 'running' }),
		events: async function* (_sessionId, afterSequence, signal, callbacks) {
			calls += 1;
			cursors.push(afterSequence);
			if (calls === 1) throw new Error('first failure');
			callbacks?.onOpen?.();
			callbacks?.onActivity?.();
			if (calls === 2) {
				yield runtimeEvent(8);
				throw new Error('failure after activity');
			}
			await waitForAbort(signal);
		}
	};
	const contents = new FakeContents();
	const registry = createRegistry(client);

	registry.watch(contents, 'cursor-session', 4);

	await waitFor(() => calls >= 3);
	assert.deepEqual(cursors.slice(0, 3), [4, 4, 8]);
	assert.deepEqual(
		contents.events
			.filter((event) => event.kind === 'session.stream' && event.state === 'retrying')
			.map((event) => (event.kind === 'session.stream' ? event.attempt : undefined)),
		[1, 1]
	);
	registry.unwatch(contents, 'cursor-session');
});

test('manual watch interrupts a pending backoff and reconnects immediately', async () => {
	let calls = 0;
	const client: SessionStreamClient = {
		session: async () => ({ status: 'running' }),
		events: async function* () {
			calls += 1;
			yield* [] as RuntimeEventWire[];
			throw new Error('offline');
		}
	};
	const contents = new FakeContents();
	const registry = new SessionStreamRegistry(client, {
		fastRetryDelaysMs: [1_000],
		slowRetryDelayMs: 1_000
	});

	registry.watch(contents, 'manual-session', 3);
	await contents.waitFor((event) => event.kind === 'session.stream' && event.state === 'retrying');
	registry.watch(contents, 'manual-session', 3);
	await waitFor(() => calls >= 2);

	assert.equal(calls, 2);
	registry.unwatch(contents, 'manual-session');
});

function createRegistry(client: SessionStreamClient): SessionStreamRegistry {
	return new SessionStreamRegistry(client, {
		fastRetryDelaysMs: [1, 1],
		slowRetryDelayMs: 1
	});
}

function runtimeEvent(sequence: number): RuntimeEventWire {
	return {
		id: sequence,
		sequence,
		sessionId: 'cursor-session',
		adapterId: 'claude-code',
		timestamp: Date.now(),
		type: 'session.status_changed',
		payload: { status: 'running' }
	};
}

function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise((resolve) =>
		signal.addEventListener('abort', () => resolve(), { once: true })
	);
}

async function waitFor(ready: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (ready()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error('Timed out waiting for stream state');
}

class FakeContents implements StreamContents {
	readonly id = 1;
	readonly events: PushEvent[] = [];

	isDestroyed(): boolean {
		return false;
	}

	once(): void {}

	send(_channel: string, event: PushEvent): void {
		this.events.push(event);
	}

	async waitFor(ready: (event: PushEvent) => boolean): Promise<PushEvent> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const event = this.events.find(ready);
			if (event) return event;
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		throw new Error('Timed out waiting for pushed event');
	}
}
