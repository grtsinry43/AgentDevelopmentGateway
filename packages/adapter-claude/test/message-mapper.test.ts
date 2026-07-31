import assert from 'node:assert/strict';
import test from 'node:test';
import { asTurnId } from '@agent-gateway/core';
import type { SDKAssistantMessage, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeMessageMapper } from '../src/message-mapper.js';
import { loadFixture } from './fixture-loader.js';

const turnId = asTurnId('gateway-test-turn');

test('maps a recorded text turn to live deltas and authoritative completion', async () => {
	const events = await mapFixture('text-turn');
	const types = events.map((event) => event.type);

	assert.ok(types.includes('session.created'));
	assert.ok(types.includes('content.text.delta'));
	assert.ok(types.includes('content.text.completed'));
	assert.ok(types.includes('usage.updated'));
	assert.ok(types.includes('turn.completed'));

	const completed = events.find((event) => event.type === 'content.text.completed');
	assert.equal(completed?.payload.text, 'gateway fixture');
});

test('does not restart content blocks for the official stream-then-assistant order', async () => {
	const recorded = await loadFixture('text-turn');
	const assistantSnapshots = recorded.filter(
		(message): message is SDKAssistantMessage => message.type === 'assistant'
	);
	assert.equal(assistantSnapshots.length, 2);
	const [reasoningSnapshot, textSnapshot] = assistantSnapshots;
	if (!reasoningSnapshot || !textSnapshot) {
		throw new Error('Expected recorded reasoning and text assistant snapshots');
	}

	const canonicalAssistant: SDKAssistantMessage = {
		...textSnapshot,
		type: 'assistant',
		message: {
			...textSnapshot.message,
			content: [...reasoningSnapshot.message.content, ...textSnapshot.message.content]
		}
	};
	const canonicalMessages: SDKMessage[] = [];
	for (const message of recorded) {
		if (message.type === 'assistant') continue;
		canonicalMessages.push(message);
		if (message.type === 'stream_event' && message.event.type === 'message_stop') {
			canonicalMessages.push(canonicalAssistant);
		}
	}

	const mapper = new ClaudeMessageMapper();
	const events = canonicalMessages.flatMap((message) => mapper.map(message, { turnId }));

	assert.equal(events.filter((event) => event.type === 'content.reasoning.started').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.text.started').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.reasoning.completed').length, 1);
	assert.equal(events.filter((event) => event.type === 'content.text.completed').length, 1);
});

test('maps a recorded denied Bash call without losing its tool lifecycle', async () => {
	const events = await mapFixture('denied-tool-turn');
	const started = events.find((event) => event.type === 'tool.started');
	const completed = events.find((event) => event.type === 'tool.completed');

	assert.equal(started?.payload.toolCall.kind, 'terminal');
	assert.equal(started?.payload.toolCall.name, 'Bash');
	assert.equal(completed?.payload.toolCall.status, 'error');
	assert.match(completed?.payload.toolCall.error?.message ?? '', /Denied by the fixture recorder/);
	assert.ok(
		events.some((event) => event.type === 'turn.completed' || event.type === 'turn.failed')
	);
});

test('preserves Claude aborted terminal reasons as an interrupted turn', async () => {
	const messages = await loadFixture('text-turn');
	const result = messages.find((message) => message.type === 'result');
	if (!result || result.subtype !== 'success') throw new Error('Fixture has no successful Claude result');

	const mapper = new ClaudeMessageMapper();
	const events = mapper.map(
		{ ...result, terminal_reason: 'aborted_streaming' as const },
		{ turnId }
	);
	const completed = events.find((event) => event.type === 'turn.completed');

	assert.equal(completed?.payload.status, 'interrupted');
});

async function mapFixture(name: string) {
	const mapper = new ClaudeMessageMapper();
	const messages = await loadFixture(name);
	return messages.flatMap((message) => mapper.map(message, { turnId }));
}
