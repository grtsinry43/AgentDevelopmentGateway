import { untrack } from 'svelte';

export type NotificationSeverity = 'info' | 'warning' | 'error';

export interface AppNotification {
	id: string;
	key?: string;
	severity: NotificationSeverity;
	title: string;
	summary: string;
	detail?: string;
	createdAt: number;
	read: boolean;
}

export interface NotificationInput {
	key?: string;
	severity: NotificationSeverity;
	title: string;
	summary: string;
	detail?: string;
}

const TOAST_DURATION_MS = 6_000;

class NotificationStore {
	items = $state.raw<AppNotification[]>([]);
	open = $state(false);
	toastId = $state<string | undefined>(undefined);
	private toastTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly activeKeys = new Set<string>();

	readonly unreadCount = $derived(this.items.filter((item) => !item.read).length);
	readonly toast = $derived(this.items.find((item) => item.id === this.toastId));

	notify(input: NotificationInput): void {
		// notify is intentionally safe to call from a reactive effect. Its internal
		// read-modify-write cycle must not become a dependency of that caller.
		untrack(() => {
			const existing = input.key ? this.items.find((item) => item.key === input.key) : undefined;
			const shouldToast = !input.key || !this.activeKeys.has(input.key);
			const notification: AppNotification = {
				id: existing?.id ?? crypto.randomUUID(),
				...(input.key ? { key: input.key } : {}),
				severity: input.severity,
				title: input.title,
				summary: input.summary,
				...(input.detail ? { detail: input.detail } : {}),
				createdAt: Date.now(),
				read: false
			};
			this.items = [
				notification,
				...this.items.filter((item) => item.id !== notification.id)
			].slice(0, 100);
			if (input.key) this.activeKeys.add(input.key);
			if (shouldToast) {
				this.toastId = notification.id;
				this.restartToastTimer();
			}
		});
	}

	resolve(key: string): void {
		this.activeKeys.delete(key);
	}

	toggle(): void {
		this.open = !this.open;
		if (this.open) {
			this.toastId = undefined;
			this.clearToastTimer();
			this.items = this.items.map((item) => ({ ...item, read: true }));
		}
	}

	close(): void {
		this.open = false;
	}

	dismissToast(): void {
		this.toastId = undefined;
		this.clearToastTimer();
	}

	clear(): void {
		this.items = [];
		this.activeKeys.clear();
		this.toastId = undefined;
		this.clearToastTimer();
	}

	private restartToastTimer(): void {
		this.clearToastTimer();
		this.toastTimer = setTimeout(() => {
			this.toastId = undefined;
			this.toastTimer = undefined;
		}, TOAST_DURATION_MS);
	}

	private clearToastTimer(): void {
		if (this.toastTimer !== undefined) clearTimeout(this.toastTimer);
		this.toastTimer = undefined;
	}
}

export const notifications = new NotificationStore();
