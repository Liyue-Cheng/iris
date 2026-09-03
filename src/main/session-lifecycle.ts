/** Window-owned lifecycle contract shared by every top-level Session domain. */
export interface SessionLifecycleParticipant {
  readonly name: string;
  busyCount(): number;
  shutdown(): Promise<void>;
}

export function countBusySessions(participants: readonly SessionLifecycleParticipant[]): number {
  return participants.reduce((total, participant) => total + participant.busyCount(), 0);
}
