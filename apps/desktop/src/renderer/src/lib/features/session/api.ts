import { desktop } from '$lib/shared/bridge/desktop';
import type {
	CreateSessionRequest,
	CreateSessionResponse,
	GatewayAdapterAvailability,
	GatewaySession,
	InputAdmissionReceipt,
	SendSessionInputRequest
} from '@agent-gateway/shared';

export function listSessions(projectKey: string): Promise<GatewaySession[]> {
	return desktop.sessions.list(projectKey);
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

export function watchSession(sessionId: string, afterSequence = 0): Promise<void> {
	return desktop.sessions.watch(sessionId, afterSequence);
}

export function unwatchSession(sessionId: string): Promise<void> {
	return desktop.sessions.unwatch(sessionId);
}
