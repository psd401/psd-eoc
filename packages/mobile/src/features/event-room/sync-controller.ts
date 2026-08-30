import type {
  Event,
  EventRoomSyncResult,
  JournalEntryReadProjection,
} from '@psd-eoc/contracts';

import {
  EMPTY_EVENT_ROOM_MODEL,
  POLL_INTERVAL_MILLISECONDS,
  TimelineAnnouncementBatcher,
  applyConfirmedMutation,
  applyEventRoomPage,
  markTimelineSeen,
  type AnnouncementScheduler,
  type EventRoomModel,
} from './model';

import { AuthenticatedRequestFailure } from '../../lib/api';

export interface EventRoomSyncPort {
  sync(
    eventId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<EventRoomSyncResult>;
}

export interface EventRoomPollScheduler {
  schedule(callback: () => void, delayMilliseconds: number): unknown;
  cancel(handle: unknown): void;
}

export interface EventRoomSyncSnapshot {
  readonly model: EventRoomModel;
  readonly phase: 'idle' | 'loading-history' | 'live' | 'error' | 'paused';
  readonly refreshing: boolean;
  readonly error: string | null;
}

const DEFAULT_SCHEDULER: EventRoomPollScheduler = Object.freeze({
  schedule(callback: () => void, delayMilliseconds: number): unknown {
    return setTimeout(callback, delayMilliseconds);
  },
  cancel(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
});

const TIMELINE_ERROR =
  'The timeline is temporarily unavailable. Reconnect, then pull to refresh.';

const UNREADABLE_TIMELINE_ERROR =
  'This version of the app cannot read the event timeline. Update the PSD EOC app, then open the event again.';

/**
 * Separates a response this build cannot read from an ordinary interruption.
 * A body the schema rejects will be rejected identically every four seconds,
 * so telling the operator to reconnect and pull to refresh sends them into a
 * loop; only a newer build resolves it.
 */
function timelineErrorMessage(error: unknown): string {
  return error instanceof AuthenticatedRequestFailure &&
    error.kind === 'invalid-response'
    ? UNREADABLE_TIMELINE_ERROR
    : TIMELINE_ERROR;
}

type Listener = () => void;

/** Serial cursor drain and polling lifecycle shared by the native screen. */
export class EventRoomSyncController {
  private snapshotValue: EventRoomSyncSnapshot = Object.freeze({
    model: EMPTY_EVENT_ROOM_MODEL,
    phase: 'idle',
    refreshing: false,
    error: null,
  });
  private readonly listeners = new Set<Listener>();
  private readonly announcements: TimelineAnnouncementBatcher;
  private inFlight: Promise<void> | null = null;
  private abortController: AbortController | null = null;
  private timerHandle: unknown | null = null;
  private active = false;
  private nearLiveEdge = true;

  public constructor(
    private readonly eventId: string,
    private readonly api: EventRoomSyncPort,
    announce: (message: string) => void,
    private readonly scheduler: EventRoomPollScheduler = DEFAULT_SCHEDULER,
    announcementScheduler?: AnnouncementScheduler,
  ) {
    this.announcements =
      announcementScheduler === undefined
        ? new TimelineAnnouncementBatcher(announce)
        : new TimelineAnnouncementBatcher(announce, announcementScheduler);
  }

  public getSnapshot = (): EventRoomSyncSnapshot => this.snapshotValue;

  public subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(value: EventRoomSyncSnapshot): void {
    this.snapshotValue = Object.freeze(value);
    for (const listener of this.listeners) listener();
  }

  public async start(): Promise<void> {
    if (this.active) return this.inFlight ?? Promise.resolve();
    this.active = true;
    const interrupted = this.inFlight;
    if (interrupted !== null) await interrupted;
    if (!this.active) return;
    const initial = !this.snapshotValue.model.historyComplete;
    await this.run(initial, !initial, false);
    this.scheduleNextPoll();
  }

  /** Pauses immediately on background/lock; no delayed mutation exists here. */
  public pause(): void {
    this.active = false;
    this.abortController?.abort();
    this.abortController = null;
    if (this.timerHandle !== null) this.scheduler.cancel(this.timerHandle);
    this.timerHandle = null;
    this.announcements.cancel();
    this.update({
      ...this.snapshotValue,
      phase: 'paused',
      refreshing: false,
    });
  }

  public stop(): void {
    this.pause();
    this.listeners.clear();
  }

  public async refresh(): Promise<void> {
    if (!this.active) return;
    const initialCatchUp = !this.snapshotValue.model.historyComplete;
    await this.run(initialCatchUp, !initialCatchUp, true);
    this.scheduleNextPoll();
  }

  public setNearLiveEdge(value: boolean): void {
    this.nearLiveEdge = value;
    if (value) this.markSeen();
  }

  public markSeen(): void {
    const model = markTimelineSeen(this.snapshotValue.model);
    if (model === this.snapshotValue.model) return;
    this.update({ ...this.snapshotValue, model });
  }

  /** Applies only a server-confirmed append/lifecycle result; never optimistic. */
  public applyConfirmed(
    event: Event | null,
    entries: readonly JournalEntryReadProjection[],
  ): void {
    const model = applyConfirmedMutation(
      this.snapshotValue.model,
      event,
      entries,
    );
    this.update({
      model,
      phase: 'live',
      refreshing: false,
      error: null,
    });
  }

  private scheduleNextPoll(): void {
    if (!this.active || this.timerHandle !== null) return;
    this.timerHandle = this.scheduler.schedule(() => {
      this.timerHandle = null;
      const initialCatchUp = !this.snapshotValue.model.historyComplete;
      void this.run(initialCatchUp, !initialCatchUp, false).finally(() => {
        this.scheduleNextPoll();
      });
    }, POLL_INTERVAL_MILLISECONDS);
  }

  private run(
    initialCatchUp: boolean,
    announce: boolean,
    refreshing: boolean,
  ): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const operation = this.drain(initialCatchUp, announce, refreshing).finally(
      () => {
        if (this.inFlight === operation) this.inFlight = null;
      },
    );
    this.inFlight = operation;
    return operation;
  }

  private async drain(
    initialCatchUp: boolean,
    announce: boolean,
    refreshing: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    this.update({
      ...this.snapshotValue,
      phase: initialCatchUp ? 'loading-history' : this.snapshotValue.phase,
      refreshing,
      error: null,
    });
    let cursor =
      initialCatchUp && this.snapshotValue.model.event === null
        ? null
        : this.snapshotValue.model.cursor;
    try {
      while (this.active) {
        const previousIds = new Set(
          this.snapshotValue.model.entries.map(({ entry }) => entry.id),
        );
        const page = await this.api.sync(
          this.eventId,
          cursor,
          controller.signal,
        );
        if (!this.active || controller.signal.aborted) return;
        if (page.eventId !== this.eventId) {
          throw new Error('PSD EOC returned another event room.');
        }
        if (page.hasMore && page.cursor === cursor) {
          throw new Error('PSD EOC returned a non-progressing timeline page.');
        }
        const model = applyEventRoomPage(this.snapshotValue.model, page, {
          initialCatchUp,
          nearLiveEdge: this.nearLiveEdge,
        });
        this.update({
          model,
          phase: 'live',
          refreshing,
          error: null,
        });
        if (announce) {
          const additions: JournalEntryReadProjection[] = model.entries.filter(
            ({ entry }) => !previousIds.has(entry.id),
          );
          this.announcements.enqueue(additions);
        }
        cursor = page.cursor;
        if (!page.hasMore) break;
      }
      if (this.active) {
        this.update({ ...this.snapshotValue, refreshing: false });
      }
    } catch (error) {
      if (controller.signal.aborted || !this.active) return;
      this.update({
        ...this.snapshotValue,
        phase: 'error',
        refreshing: false,
        error: timelineErrorMessage(error),
      });
    } finally {
      if (this.abortController === controller) this.abortController = null;
    }
  }
}
