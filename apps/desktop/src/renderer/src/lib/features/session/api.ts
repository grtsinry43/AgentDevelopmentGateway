import { desktop } from '$lib/shared/bridge/desktop';
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	CloseSessionRequest,
	ForkSessionRequest,
	GatewayAdapterAvailability,
	GatewaySession,
	InputAdmissionReceipt,
	ReorderQueuedInputsRequest,
	ReplaceQueuedInputRequest,
	InterruptSessionRequest,
	ResolveInteractionRequest,
	ResumeSessionRequest,
	RuntimeControlReceipt,
	SendSessionInputRequest,
	SetExecutionSettingsRequest,
	SetSessionModelRequest,
	SetSessionTitleRequest,
	SetWorkModeRequest
} from '@agent-gateway/shared';

export function listSessions(projectKey: string): Promise<GatewaySession[]> {
	return desktop.sessions.list(projectKey);
}

export function getSession(sessionId: string): Promise<GatewaySession> {
	return desktop.sessions.get(sessionId);
}

export function listAdapters(projectKey: string): Promise<GatewayAdapterAvailability[]> {
	return desktop.sessions.adapters(projectKey);
}

export function createSession(
	projectKey: string,
	input: CreateSessionRequest
): Promise<CreateSessionResponse> {
	return desktop.sessions.create(projectKey, input);
}

export function sendSessionInput(
	sessionId: string,
	input: SendSessionInputRequest
): Promise<InputAdmissionReceipt> {
	return desktop.sessions.send(sessionId, input);
}

export function replaceQueuedInput(
	sessionId: string,
	inputId: string,
	input: ReplaceQueuedInputRequest
): Promise<void> {
	return desktop.sessions.replaceQueuedInput(sessionId, inputId, input);
}

export function reorderQueuedInputs(
	sessionId: string,
	input: ReorderQueuedInputsRequest
): Promise<void> {
	return desktop.sessions.reorderQueuedInputs(sessionId, input);
}

export function cancelQueuedInput(sessionId: string, inputId: string): Promise<void> {
	return desktop.sessions.cancelQueuedInput(sessionId, inputId);
}

export function sendQueuedInputNow(sessionId: string, inputId: string): Promise<void> {
	return desktop.sessions.sendQueuedInputNow(sessionId, inputId);
}

export function interruptSession(
	sessionId: string,
	input: InterruptSessionRequest = {}
): Promise<void> {
	return desktop.sessions.interrupt(sessionId, input);
}

export function resolveSessionInteraction(
	sessionId: string,
	interactionId: string,
	input: ResolveInteractionRequest
): Promise<void> {
	return desktop.sessions.resolveInteraction(sessionId, interactionId, input);
}

export function closeSession(
	sessionId: string,
	input: CloseSessionRequest = {}
): Promise<RuntimeControlReceipt> {
	return desktop.sessions.close(sessionId, input);
}

export function resumeSession(
	sessionId: string,
	input: ResumeSessionRequest = {}
): Promise<GatewaySession> {
	return desktop.sessions.resume(sessionId, input);
}

export function forkSession(
	sessionId: string,
	input: ForkSessionRequest = {}
): Promise<GatewaySession> {
	return desktop.sessions.fork(sessionId, input);
}

export function setSessionTitle(
	sessionId: string,
	input: SetSessionTitleRequest
): Promise<RuntimeControlReceipt> {
	return desktop.sessions.setTitle(sessionId, input);
}

export function setSessionModel(
	sessionId: string,
	input: SetSessionModelRequest
): Promise<RuntimeControlReceipt> {
	return desktop.sessions.setModel(sessionId, input);
}

export function setSessionWorkMode(
	sessionId: string,
	input: SetWorkModeRequest
): Promise<RuntimeControlReceipt> {
	return desktop.sessions.setWorkMode(sessionId, input);
}

export function setSessionExecutionSettings(
	sessionId: string,
	input: SetExecutionSettingsRequest
): Promise<RuntimeControlReceipt> {
	return desktop.sessions.setExecutionSettings(sessionId, input);
}

export function watchSession(sessionId: string, afterSequence = 0): Promise<void> {
	return desktop.sessions.watch(sessionId, afterSequence);
}

export function unwatchSession(sessionId: string): Promise<void> {
	return desktop.sessions.unwatch(sessionId);
}
