import { useSyncExternalStore } from 'react';
import type { AppErrorDomain } from '@shared/app-error';

export interface NotificationAction {
  label: string;
  run: () => void;
}

export interface AppNotification {
  id: string;
  dedupeKey: string;
  level: 'info' | 'error';
  title: string;
  message: string;
  sticky: boolean;
  occurrences: number;
  createdAt: number;
  incidentId?: string;
  domain?: AppErrorDomain;
  action?: NotificationAction;
}

export interface NotificationInput {
  dedupeKey: string;
  level?: AppNotification['level'];
  title: string;
  message: string;
  sticky?: boolean;
  incidentId?: string;
  domain?: AppErrorDomain;
  action?: NotificationAction;
}

let notifications: AppNotification[] = [];
let sequence = 0;
const subscribers = new Set<() => void>();
const dismissTimers = new Map<string, ReturnType<typeof setTimeout>>();

function emit(): void {
  subscribers.forEach((subscriber) => subscriber());
}

function scheduleDismiss(notification: AppNotification): void {
  const existing = dismissTimers.get(notification.id);
  if (existing) clearTimeout(existing);
  if (notification.sticky) return;
  dismissTimers.set(notification.id, setTimeout(() => {
    dismissTimers.delete(notification.id);
    dismissNotification(notification.id);
  }, 7000));
}

export function notify(input: NotificationInput): string {
  const existingIndex = notifications.findIndex(
    (notification) => notification.dedupeKey === input.dedupeKey,
  );
  if (existingIndex >= 0) {
    const existing = notifications[existingIndex]!;
    const updated: AppNotification = {
      ...existing,
      level: input.level ?? existing.level,
      title: input.title,
      message: input.message,
      sticky: input.sticky ?? existing.sticky,
      occurrences: existing.occurrences + 1,
      ...(input.incidentId !== undefined ? { incidentId: input.incidentId } : {}),
      ...(input.domain !== undefined ? { domain: input.domain } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
    };
    notifications = [
      ...notifications.slice(0, existingIndex),
      updated,
      ...notifications.slice(existingIndex + 1),
    ];
    scheduleDismiss(updated);
    emit();
    return existing.id;
  }

  const notification: AppNotification = {
    id: `notification-${Date.now()}-${sequence++}`,
    dedupeKey: input.dedupeKey,
    level: input.level ?? 'error',
    title: input.title,
    message: input.message,
    sticky: input.sticky ?? false,
    occurrences: 1,
    createdAt: Date.now(),
    ...(input.incidentId !== undefined ? { incidentId: input.incidentId } : {}),
    ...(input.domain !== undefined ? { domain: input.domain } : {}),
    ...(input.action !== undefined ? { action: input.action } : {}),
  };
  notifications = [...notifications, notification];
  scheduleDismiss(notification);
  emit();
  return notification.id;
}

export function dismissNotification(id: string): void {
  const timer = dismissTimers.get(id);
  if (timer) clearTimeout(timer);
  dismissTimers.delete(id);
  const next = notifications.filter((notification) => notification.id !== id);
  if (next.length === notifications.length) return;
  notifications = next;
  emit();
}

export function clearNotifications(): void {
  dismissTimers.forEach((timer) => clearTimeout(timer));
  dismissTimers.clear();
  notifications = [];
  emit();
}

export function getNotifications(): readonly AppNotification[] {
  return notifications;
}

export function useNotifications(): readonly AppNotification[] {
  return useSyncExternalStore(
    (subscriber) => {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    getNotifications,
  );
}
