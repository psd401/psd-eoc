import {
  JournalEntryReadProjectionSchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  projectJournalEntryForRead,
  type EventKind,
  type LifecycleConsequencePreview,
  type TemplateMode,
} from '@psd-eoc/contracts';
import { describe, expect, jest, test } from '@jest/globals';
import * as Crypto from 'expo-crypto';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import { useState } from 'react';
import { AppState, Text } from 'react-native';

import {
  EVENT_ROOM_MUTED_TEXT_COLOR,
  JournalActionDialog,
  LifecycleConfirmationDialog,
  LocationComposerDialog,
  PhotoComposerDialog,
  TimelineEntryCard,
  captureForegroundPosition,
  eventStatusAcceptsTimelinePosts,
  invalidateLocationCaptureForPostingState,
  retainJournalMutationIdentity,
} from '../src/features/event-room/event-room-screen';
import {
  NativePhotoDraftStorage,
  type PendingPhotoSelectionLease,
  type PendingPhotoSelectionOwner,
  type PhotoSource,
} from '../src/features/event-room/native-photo';
import {
  parsePhotoDraftManifest,
  type PhotoDraftManifest,
} from '../src/features/event-room/photo-draft';
import {
  useEventPhotoDraft,
  type EventPhotoDraftWorkflow,
} from '../src/features/event-room/use-event-photo-draft';
import type { EventRoomApi } from '../src/features/event-room/api';

const ids = {
  audience: '10000000-0000-4000-8000-000000000001',
  event: '10000000-0000-4000-8000-000000000002',
  eventType: '10000000-0000-4000-8000-000000000003',
  media: '10000000-0000-4000-8000-000000000004',
  otherEvent: '10000000-0000-4000-8000-000000000009',
  preview: '10000000-0000-4000-8000-000000000005',
  roster: '10000000-0000-4000-8000-000000000006',
  session: '10000000-0000-4000-8000-000000000007',
  user: '10000000-0000-4000-8000-000000000008',
} as const;

const createdAt = '2099-08-11T20:00:00.000Z';
const expiresAt = '2099-08-11T20:04:00.000Z';
const target = Object.freeze({
  eventTypeName: 'Synthetic lockdown',
  facilityName: 'Synthetic School',
  facilityCode: 'SYN',
});

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return (
    (channels[0] ?? 0) * 0.2126 +
    (channels[1] ?? 0) * 0.7152 +
    (channels[2] ?? 0) * 0.0722
  );
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function integrationStatus(channel: 'push' | 'email') {
  return {
    integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
    label: 'live-verified' as const,
    verifiedAt: createdAt,
    verifiedByUserId: ids.user,
    authorizationReference: 'approved-native-test-fixture',
    reasonCode: null,
    observedAt: createdAt,
  };
}

function mockedIntegrationStatus(channel: 'push' | 'email') {
  return {
    integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
    label: 'mocked' as const,
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: createdAt,
  };
}

function lifecyclePreview(
  mode: TemplateMode,
  blocked = false,
  kind: EventKind = mode === 'real' ? 'incident' : 'drill',
): LifecycleConsequencePreview {
  const marker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  return LifecycleConsequencePreviewSchema.parse({
    id: ids.preview,
    eventId: ids.event,
    purpose: 'all-clear',
    kind,
    templateMode: mode,
    eventTypeVersion: { id: ids.eventType, templateMode: mode },
    rosterSnapshotId: ids.roster,
    rosterPopulation: kind === 'test' ? 'synthetic' : 'staff',
    recipientCount: 42,
    channels: [
      {
        channel: 'push',
        endpointCount: 42,
        renderedMessage: {
          channel: 'push',
          eventKind: kind,
          templateMode: mode,
          purpose: 'all-clear',
          classificationMarker: marker,
          title: `[${marker}] ALL CLEAR: Synthetic ${mode === 'real' ? 'incident' : 'drill'}`,
          body: `[${marker}] Synthetic push all-clear instructions.`,
        },
        integrationStatus:
          kind === 'test'
            ? mockedIntegrationStatus('push')
            : integrationStatus('push'),
      },
      {
        channel: 'email',
        endpointCount: 40,
        renderedMessage: {
          channel: 'email',
          eventKind: kind,
          templateMode: mode,
          purpose: 'all-clear',
          classificationMarker: marker,
          subject: `[${marker}] ALL CLEAR: Synthetic ${mode === 'real' ? 'incident' : 'drill'}`,
          textBody: `[${marker}] Synthetic email all-clear instructions.`,
        },
        integrationStatus:
          kind === 'test'
            ? mockedIntegrationStatus('email')
            : integrationStatus('email'),
      },
    ],
    sendReadiness: blocked ? 'blocked' : 'ready',
    blockingReasonCodes: blocked ? ['PUSH_NOT_LIVE_VERIFIED'] : [],
    consequenceDigest: 'a'.repeat(64),
    createdAt,
    expiresAt,
  });
}

function ConfirmationHarness({
  action,
  mode,
  onConfirm,
  preview,
}: Readonly<{
  action: 'all-clear' | 'close';
  mode: TemplateMode;
  onConfirm: () => void;
  preview: LifecycleConsequencePreview | null;
}>) {
  return (
    <LifecycleConfirmationDialog
      action={action}
      busy={false}
      error={null}
      loadingPreview={false}
      mode={mode}
      onConfirm={onConfirm}
      onDismiss={() => undefined}
      onRefreshPreview={() => undefined}
      preview={preview}
      target={{
        ...target,
        eventKind: preview?.kind ?? (mode === 'real' ? 'incident' : 'drill'),
      }}
      visible
    />
  );
}

function expectConfirmationDisabled(disabled: boolean): void {
  expect(
    screen.getByTestId('lifecycle-confirm-button').props.accessibilityState,
  ).toEqual({ disabled });
}

function PhotoWorkflowHarness({
  api,
  eventId,
  newPostsAllowed = true,
  onWorkflow,
  sessionId,
}: Readonly<{
  api: EventRoomApi;
  eventId: string;
  newPostsAllowed?: boolean;
  onWorkflow: (workflow: EventPhotoDraftWorkflow) => void;
  sessionId: string;
}>) {
  const workflow = useEventPhotoDraft({
    api,
    entries: [],
    eventId,
    newPostsAllowed,
    onAppended: () => undefined,
    sessionId,
  });
  onWorkflow(workflow);
  return (
    <Text testID="photo-workflow-state">
      {workflow.busy ? 'busy' : 'idle'}:{workflow.draft?.stage ?? 'none'}:
      {workflow.draft?.altText ?? ''}
    </Text>
  );
}

function ConnectedPhotoComposerHarness({
  api,
  onAppended,
}: Readonly<{
  api: EventRoomApi;
  onAppended: () => void;
}>) {
  const photo = useEventPhotoDraft({
    api,
    entries: [],
    eventId: ids.event,
    newPostsAllowed: true,
    onAppended,
    sessionId: ids.session,
  });
  return (
    <PhotoComposerDialog
      newPostsAllowed
      onDismiss={() => undefined}
      online
      photo={photo}
      target={target}
      templateMode="drill"
      visible
    />
  );
}

function MutablePhotoWorkflowHarness({
  api,
  onWorkflow,
}: Readonly<{
  api: EventRoomApi;
  onWorkflow: (workflow: EventPhotoDraftWorkflow) => void;
}>) {
  const [eventId, setEventId] = useState<string>(ids.event);
  const [newPostsAllowed, setNewPostsAllowed] = useState(true);
  const workflow = useEventPhotoDraft({
    api,
    entries: [],
    eventId,
    newPostsAllowed,
    onAppended: () => undefined,
    sessionId: ids.session,
  });
  onWorkflow(workflow);
  return (
    <>
      <Text testID="photo-workflow-state">
        {workflow.busy ? 'busy' : 'idle'}:{workflow.draft?.stage ?? 'none'}:
        {workflow.draft?.altText ?? ''}
      </Text>
      <Text
        testID="set-photo-posting-allowed"
        onPress={() => setNewPostsAllowed(true)}
      >
        allow
      </Text>
      <Text
        testID="set-photo-posting-blocked"
        onPress={() => setNewPostsAllowed(false)}
      >
        block
      </Text>
      <Text
        testID="set-photo-event-other"
        onPress={() => setEventId(ids.otherEvent)}
      >
        other event
      </Text>
    </>
  );
}

function readyPhotoManifest(): PhotoDraftManifest {
  return parsePhotoDraftManifest({
    version: 1,
    draftId: '10000000-0000-4000-8000-000000000009',
    eventId: ids.event,
    sessionId: ids.session,
    localUri:
      'file:///documents/event-photo-drafts/10000000-0000-4000-8000-000000000009.private-photo',
    byteLength: 128,
    contentSha256: 'a'.repeat(64),
    declaredContentType: 'image/jpeg',
    altText: 'Canonical synthetic entrance photo',
    caption: 'Canonical synthetic caption',
    stage: 'ready',
    retryStage: null,
    cleanupProof: null,
    uploadIntentId: null,
    mediaId: null,
    idempotencyKeys: {
      createIntent: 'photo-create-intent-key-native-0001',
      completeUpload: 'photo-complete-upload-key-native-0001',
      appendEntry: 'photo-append-entry-key-native-0001',
    },
  });
}

function pendingPhotoOwner(
  overrides: Partial<{
    selectionId: string;
    draftId: string;
    eventId: string;
    sessionId: string;
  }> = {},
) {
  return Object.freeze({
    version: 1 as const,
    selectionId:
      overrides.selectionId ?? '10000000-0000-4000-8000-000000000010',
    draftId: overrides.draftId ?? '10000000-0000-4000-8000-000000000011',
    eventId: overrides.eventId ?? ids.event,
    sessionId: overrides.sessionId ?? ids.session,
  });
}

function rejectingPhotoApi(): EventRoomApi {
  return {
    createMediaUploadIntent: jest.fn(async () => {
      throw new Error('synthetic bounded network failure');
    }),
    completeMediaUpload: jest.fn(),
    postPhoto: jest.fn(),
  } as unknown as EventRoomApi;
}

describe('mobile event-room mutation reliability', () => {
  test('retains the complete text/location request identity until the canonical draft changes', () => {
    const first = retainJournalMutationIdentity(
      null,
      'canonical draft',
      () => 'synthetic-journal-key-0001',
      () => '2026-08-11T20:05:00.000Z',
    );
    const replay = retainJournalMutationIdentity(
      first,
      'canonical draft',
      () => 'must-not-rotate',
      () => 'must-not-regenerate',
    );

    expect(replay).toBe(first);
    expect(replay).toEqual({
      idempotencyKey: 'synthetic-journal-key-0001',
      clientTime: '2026-08-11T20:05:00.000Z',
      canonicalDraft: 'canonical draft',
    });
    expect(
      retainJournalMutationIdentity(
        first,
        'changed canonical draft',
        () => 'synthetic-journal-key-0002',
        () => '2026-08-11T20:06:00.000Z',
      ),
    ).toEqual({
      idempotencyKey: 'synthetic-journal-key-0002',
      clientTime: '2026-08-11T20:06:00.000Z',
      canonicalDraft: 'changed canonical draft',
    });
  });

  test('bounds foreground GPS capture and rejects a stale backgrounded result', async () => {
    let deadline: (() => void) | undefined;
    const timedOut = captureForegroundPosition({
      requestPermission: () => Promise.resolve({ status: 'granted' }),
      getPosition: () => new Promise(() => undefined),
      isCurrentForegroundCapture: () => true,
      timeoutMilliseconds: 5,
    });
    await expect(timedOut).rejects.toThrow(
      'GPS capture timed out. Choose ambiguous or unknown instead.',
    );

    let current = true;
    const position = new Promise<{
      readonly coords: {
        readonly latitude: number;
        readonly longitude: number;
        readonly accuracy: number | null;
      };
    }>((resolve) => {
      deadline = () =>
        resolve({
          coords: { latitude: 47.4, longitude: -122.6, accuracy: 18 },
        });
    });
    const stale = captureForegroundPosition({
      requestPermission: () => Promise.resolve({ status: 'granted' }),
      getPosition: () => position,
      isCurrentForegroundCapture: () => current,
      timeoutMilliseconds: 100,
    });
    current = false;
    deadline?.();
    await expect(stale).rejects.toThrow(
      'GPS capture stopped when the app left the foreground.',
    );
  });

  test('keeps composers and GPS eligible through all-clear, then invalidates non-postable event states', async () => {
    expect(eventStatusAcceptsTimelinePosts('active')).toBe(true);
    expect(eventStatusAcceptsTimelinePosts('all-clear')).toBe(true);
    expect(eventStatusAcceptsTimelinePosts('draft')).toBe(false);
    expect(eventStatusAcceptsTimelinePosts('closed')).toBe(false);

    const generation = 7;
    let currentGeneration = generation;
    let resolvePosition:
      | ((value: {
          readonly coords: {
            readonly latitude: number;
            readonly longitude: number;
            readonly accuracy: number | null;
          };
        }) => void)
      | undefined;
    const capture = captureForegroundPosition({
      requestPermission: () => Promise.resolve({ status: 'granted' }),
      getPosition: () =>
        new Promise((resolve) => {
          resolvePosition = resolve;
        }),
      isCurrentForegroundCapture: () => currentGeneration === generation,
      timeoutMilliseconds: 100,
    });

    expect(
      invalidateLocationCaptureForPostingState(true, currentGeneration),
    ).toBe(generation);
    currentGeneration = invalidateLocationCaptureForPostingState(
      false,
      currentGeneration,
    );
    resolvePosition?.({
      coords: { latitude: 47.4, longitude: -122.6, accuracy: 18 },
    });

    await expect(capture).rejects.toThrow(
      'GPS capture stopped when the app left the foreground.',
    );
  });

  test('locks the canonical photo description synchronously before the first durable submit transition', async () => {
    const manifest = readyPhotoManifest();
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalSave = NativePhotoDraftStorage.prototype.save;
    let blockFirstTransition = true;
    NativePhotoDraftStorage.prototype.load = jest.fn(async () => manifest);
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => null,
    );
    NativePhotoDraftStorage.prototype.save = jest.fn(
      async (next: PhotoDraftManifest, expected: PhotoDraftManifest | null) => {
        expect(expected).toEqual(manifest);
        if (blockFirstTransition) {
          expect(next.stage).toBe('creating-intent');
          blockFirstTransition = false;
          await Promise.resolve();
        }
      },
    );
    let workflow: EventPhotoDraftWorkflow | null = null;
    try {
      render(
        <PhotoWorkflowHarness
          api={rejectingPhotoApi()}
          eventId={ids.event}
          onWorkflow={(next) => {
            workflow = next;
          }}
          sessionId={ids.session}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:ready'),
      );

      let submit: Promise<void> | undefined;
      act(() => {
        submit = workflow!.submit();
      });
      expect(
        screen.getByTestId('photo-workflow-state').props.children.join(''),
      ).toContain('busy:ready');

      act(() => {
        workflow!.setAltText('Late description that must be ignored');
        workflow!.setCaption('Late caption that must be ignored');
      });
      expect(
        screen.getByTestId('photo-workflow-state').props.children.join(''),
      ).toContain(manifest.altText);

      await act(async () => submit);
      expect(manifest.altText).toBe('Canonical synthetic entrance photo');
      expect(manifest.caption).toBe('Canonical synthetic caption');
    } finally {
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.save = originalSave;
    }
  });

  test('blocks a foreign pending owner before reading, then rehydrates the untouched current manifest after exact discard', async () => {
    const manifest = readyPhotoManifest();
    const foreign = pendingPhotoOwner({
      eventId: '10000000-0000-4000-8000-000000000012',
      sessionId: '10000000-0000-4000-8000-000000000013',
    });
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalDiscardPending =
      NativePhotoDraftStorage.prototype.discardPendingSelection;
    const originalClearPending =
      NativePhotoDraftStorage.prototype.clearPendingSelection;
    let retainedPending: typeof foreign | null = foreign;
    const load = jest.fn(async () => manifest);
    const discardPending = jest.fn(async () => {
      retainedPending = null;
      return 'discarded-uncommitted' as const;
    });
    NativePhotoDraftStorage.prototype.load = load;
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => retainedPending,
    );
    NativePhotoDraftStorage.prototype.discardPendingSelection = discardPending;
    NativePhotoDraftStorage.prototype.clearPendingSelection = jest.fn(
      async () => undefined,
    );
    let workflow: EventPhotoDraftWorkflow | null = null;
    try {
      render(
        <PhotoWorkflowHarness
          api={rejectingPhotoApi()}
          eventId={ids.event}
          onWorkflow={(next) => {
            workflow = next;
          }}
          sessionId={ids.session}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:retained-owner'),
      );
      expect(load).not.toHaveBeenCalled();
      expect(workflow!.draft?.localCleanupOnly).toBe(true);

      await act(async () => workflow!.discard());
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain(`idle:ready:${manifest.altText}`),
      );
      expect(discardPending).toHaveBeenCalledWith(foreign);
      expect(load).toHaveBeenCalledWith(ids.event);
    } finally {
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.discardPendingSelection =
        originalDiscardPending;
      NativePhotoDraftStorage.prototype.clearPendingSelection =
        originalClearPending;
    }
  });

  test('serializes rapid status rehydration behind cumulative active-controller retirement', async () => {
    const ready = readyPhotoManifest();
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalSave = NativePhotoDraftStorage.prototype.save;
    const originalAppState = AppState.currentState;
    let stored: PhotoDraftManifest = ready;
    let releaseCreating: (() => void) | undefined;
    const creatingBlocked = new Promise<void>((resolve) => {
      releaseCreating = resolve;
    });
    let creatingStarted: (() => void) | undefined;
    const creatingDidStart = new Promise<void>((resolve) => {
      creatingStarted = resolve;
    });
    let releaseUnknown: (() => void) | undefined;
    const unknownBlocked = new Promise<void>((resolve) => {
      releaseUnknown = resolve;
    });
    let unknownStarted: (() => void) | undefined;
    const unknownDidStart = new Promise<void>((resolve) => {
      unknownStarted = resolve;
    });
    const load = jest.fn(async () => stored);
    NativePhotoDraftStorage.prototype.load = load;
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => null,
    );
    NativePhotoDraftStorage.prototype.save = jest.fn(
      async (next: PhotoDraftManifest, expected: PhotoDraftManifest | null) => {
        expect(stored).toEqual(expected);
        if (next.stage === 'creating-intent') {
          creatingStarted?.();
          await creatingBlocked;
          stored = next;
          return;
        }
        if (next.stage === 'unknown') {
          unknownStarted?.();
          await unknownBlocked;
          stored = next;
          return;
        }
        stored = next;
      },
    );
    const createMediaUploadIntent = jest.fn(
      (_input, _key, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          const rejectAbort = () => reject(signal.reason);
          if (signal.aborted) rejectAbort();
          else signal.addEventListener('abort', rejectAbort, { once: true });
        }),
    );
    const api = {
      ...rejectingPhotoApi(),
      createMediaUploadIntent,
    } as unknown as EventRoomApi;
    let workflow: EventPhotoDraftWorkflow | null = null;
    let submit: Promise<void> | undefined;
    try {
      AppState.currentState = 'active';
      render(
        <MutablePhotoWorkflowHarness
          api={api}
          onWorkflow={(next) => {
            workflow = next;
          }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:ready'),
      );
      const initialLoadCount = load.mock.calls.length;
      act(() => {
        submit = workflow!.submit();
      });
      await creatingDidStart;

      fireEvent.press(screen.getByTestId('set-photo-posting-blocked'));
      fireEvent.press(screen.getByTestId('set-photo-posting-allowed'));
      fireEvent.press(screen.getByTestId('set-photo-posting-blocked'));
      await act(async () => Promise.resolve());
      expect(load).toHaveBeenCalledTimes(initialLoadCount);
      expect(createMediaUploadIntent).toHaveBeenCalledTimes(0);

      await act(async () => {
        releaseCreating?.();
        await unknownDidStart;
      });
      expect(load).toHaveBeenCalledTimes(initialLoadCount);
      expect(createMediaUploadIntent).toHaveBeenCalledTimes(0);

      await act(async () => {
        releaseUnknown?.();
        await submit;
      });
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:unknown'),
      );
      expect(load).toHaveBeenCalledTimes(initialLoadCount + 2);
      expect(createMediaUploadIntent).toHaveBeenCalledTimes(0);
      expect(stored).toMatchObject({
        stage: 'unknown',
        retryStage: 'create-intent',
      });
    } finally {
      releaseCreating?.();
      releaseUnknown?.();
      AppState.currentState = originalAppState;
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.save = originalSave;
    }
  });

  test('waits for controller-null cleanup before hydrating a replacement event scope', async () => {
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalLoadComposer = NativePhotoDraftStorage.prototype.loadComposer;
    const originalDeleteComposer =
      NativePhotoDraftStorage.prototype.deleteComposer;
    const load = jest.fn(async () => null);
    NativePhotoDraftStorage.prototype.load = load;
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => null,
    );
    NativePhotoDraftStorage.prototype.loadComposer = jest.fn(
      async (eventId: string) =>
        eventId === ids.otherEvent
          ? {
              altText: 'Replacement event synthetic description',
              caption: null,
            }
          : null,
    );
    let cleanupStarted: (() => void) | undefined;
    const cleanupDidStart = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let releaseCleanup: (() => void) | undefined;
    const cleanupBlocked = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    NativePhotoDraftStorage.prototype.deleteComposer = jest.fn(
      async (eventId: string) => {
        if (eventId === ids.event) {
          cleanupStarted?.();
          await cleanupBlocked;
        }
      },
    );
    let workflow: EventPhotoDraftWorkflow | null = null;
    let discard: Promise<void> | undefined;
    try {
      render(
        <MutablePhotoWorkflowHarness
          api={rejectingPhotoApi()}
          onWorkflow={(next) => {
            workflow = next;
          }}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:describe'),
      );

      act(() => {
        discard = workflow!.discard();
      });
      await cleanupDidStart;
      fireEvent.press(screen.getByTestId('set-photo-event-other'));
      await act(async () => Promise.resolve());
      expect(load).toHaveBeenCalledTimes(1);
      expect(load).not.toHaveBeenCalledWith(ids.otherEvent);

      releaseCleanup?.();
      await act(async () => discard);
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:describe:Replacement event synthetic description'),
      );
      expect(load).toHaveBeenCalledWith(ids.otherEvent);
      await act(async () => Promise.resolve());
      expect(workflow!.draft?.altText).toBe(
        'Replacement event synthetic description',
      );
    } finally {
      releaseCleanup?.();
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.loadComposer = originalLoadComposer;
      NativePhotoDraftStorage.prototype.deleteComposer = originalDeleteComposer;
    }
  });

  test('keeps same-scope composer cleanup reachable after pending tombstone succeeds and composer deletion fails', async () => {
    const pending = pendingPhotoOwner();
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalLoadComposer = NativePhotoDraftStorage.prototype.loadComposer;
    const originalDiscardPending =
      NativePhotoDraftStorage.prototype.discardPendingSelection;
    const originalDeleteComposer =
      NativePhotoDraftStorage.prototype.deleteComposer;
    let retainedPending: typeof pending | null = pending;
    let retainedComposer = {
      altText: 'Synthetic selected photo description',
      caption: null,
    };
    let deleteCalls = 0;
    NativePhotoDraftStorage.prototype.load = jest.fn(async () => null);
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => retainedPending,
    );
    NativePhotoDraftStorage.prototype.loadComposer = jest.fn(
      async () => retainedComposer,
    );
    NativePhotoDraftStorage.prototype.discardPendingSelection = jest.fn(
      async () => {
        retainedPending = null;
        return 'discarded-uncommitted' as const;
      },
    );
    NativePhotoDraftStorage.prototype.deleteComposer = jest.fn(async () => {
      deleteCalls += 1;
      if (deleteCalls === 1)
        throw new Error('synthetic composer delete failure');
      retainedComposer = null as never;
    });
    let workflow: EventPhotoDraftWorkflow | null = null;
    try {
      render(
        <PhotoWorkflowHarness
          api={rejectingPhotoApi()}
          eventId={ids.event}
          newPostsAllowed={false}
          onWorkflow={(next) => {
            workflow = next;
          }}
          sessionId={ids.session}
        />,
      );
      await waitFor(() =>
        expect(workflow!.draft?.stage).toBe('retained-owner'),
      );

      await act(async () => workflow!.discard());
      await waitFor(() => {
        expect(retainedPending).toBeNull();
        expect(workflow!.draft?.stage).toBe('retained-owner');
        expect(workflow!.draft?.localCleanupOnly).toBe(true);
      });
      expect(deleteCalls).toBe(1);

      await act(async () => workflow!.discard());
      await waitFor(() => {
        expect(deleteCalls).toBe(2);
        expect(workflow!.draft?.stage).toBe('describe');
      });
    } finally {
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.loadComposer = originalLoadComposer;
      NativePhotoDraftStorage.prototype.discardPendingSelection =
        originalDiscardPending;
      NativePhotoDraftStorage.prototype.deleteComposer = originalDeleteComposer;
    }
  });

  test('redacts a prior-session manifest while retaining exact local cleanup', async () => {
    const prior = parsePhotoDraftManifest({
      ...readyPhotoManifest(),
      sessionId: '10000000-0000-4000-8000-000000000013',
      altText: 'PRIVATE PRIOR SESSION DESCRIPTION',
      caption: 'PRIVATE PRIOR SESSION CAPTION',
    });
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    NativePhotoDraftStorage.prototype.load = jest.fn(async () => prior);
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => null,
    );
    let workflow: EventPhotoDraftWorkflow | null = null;
    try {
      render(
        <PhotoWorkflowHarness
          api={rejectingPhotoApi()}
          eventId={ids.event}
          onWorkflow={(next) => {
            workflow = next;
          }}
          sessionId={ids.session}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId('photo-workflow-state').props.children.join(''),
        ).toContain('idle:retained-owner:'),
      );
      expect(workflow!.draft?.altText).toBe('');
      expect(workflow!.draft?.caption).toBeNull();
      expect(JSON.stringify(screen.toJSON())).not.toContain('PRIVATE PRIOR');
    } finally {
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
    }
  });

  test('keeps small timeline and all-clear metadata at WCAG AA contrast', () => {
    expect(
      contrastRatio(EVENT_ROOM_MUTED_TEXT_COLOR, '#FFFFFF'),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      contrastRatio(EVENT_ROOM_MUTED_TEXT_COLOR, '#F4F7FA'),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

describe('mobile event-room timeline accessibility', () => {
  test('groups each entry into one accessible timeline fact and omits every redacted photo payload field', () => {
    const visible = JournalEntryReadProjectionSchema.parse({
      visibility: 'visible',
      entry: {
        id: '10000000-0000-4000-8000-000000000010',
        eventId: ids.event,
        sequence: 1,
        kind: 'text',
        author: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        authorDisplayName: null,
        source: 'mobile',
        serverTime: '2026-08-11T20:01:00.000Z',
        clientTime: null,
        payload: { text: 'Synthetic staff update' },
        supersedes: null,
      },
    });
    const originalPhoto = JournalEntrySchema.parse({
      id: '10000000-0000-4000-8000-000000000011',
      eventId: ids.event,
      sequence: 2,
      kind: 'photo',
      author: {
        kind: 'human',
        userId: ids.user,
        sessionId: ids.session,
      },
      authorDisplayName: null,
      source: 'mobile',
      serverTime: '2026-08-11T20:02:00.000Z',
      clientTime: null,
      payload: {
        mediaId: ids.media,
        altText: 'PRIVATE SYNTHETIC PHOTO DESCRIPTION',
        caption: 'PRIVATE SYNTHETIC PHOTO CAPTION',
      },
      supersedes: null,
    });
    const redacted = projectJournalEntryForRead(originalPhoto, true);
    const getMediaReadGrant = jest.fn(() =>
      Promise.reject(new Error('A redacted photo must never request media.')),
    );

    const rendered = render(
      <>
        <TimelineEntryCard projection={visible} />
        <TimelineEntryCard api={{ getMediaReadGrant }} projection={redacted} />
      </>,
    );

    const visibleCard = screen.getByTestId('timeline-entry-1');
    const redactedCard = screen.getByTestId('timeline-entry-2');
    expect(screen.getAllByRole('text')).toHaveLength(2);
    expect(visibleCard.props.accessible).toBe(true);
    expect(visibleCard.props.accessibilityRole).toBe('text');
    expect(visibleCard.props.accessibilityLabel).toContain('Staff member at');
    expect(visibleCard.props.accessibilityLabel).toContain(
      'Synthetic staff update',
    );
    expect(redactedCard.props.accessible).toBe(true);
    expect(redactedCard.props.accessibilityRole).toBe('text');
    expect(redactedCard.props.accessibilityLabel).toContain(
      'This content was hidden later. The original record is kept.',
    );
    expect(JSON.stringify(redacted)).not.toContain('payload');
    expect(JSON.stringify(rendered.toJSON())).not.toContain(ids.media);
    expect(JSON.stringify(rendered.toJSON())).not.toContain(
      'PRIVATE SYNTHETIC PHOTO',
    );
    expect(getMediaReadGrant).not.toHaveBeenCalled();
  });

  test('lets a human explicitly retry a transient authorized timeline-photo read', async () => {
    const photo = JournalEntryReadProjectionSchema.parse({
      visibility: 'visible',
      entry: {
        id: '10000000-0000-4000-8000-000000000012',
        eventId: ids.event,
        sequence: 3,
        kind: 'photo',
        author: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        authorDisplayName: null,
        source: 'mobile',
        serverTime: '2026-08-11T20:03:00.000Z',
        clientTime: null,
        payload: {
          mediaId: ids.media,
          altText: 'Synthetic empty hallway',
          caption: null,
        },
        supersedes: null,
      },
    });
    const getMediaReadGrant = jest
      .fn<
        () => Promise<{
          readonly eventId: string;
          readonly mediaId: string;
          readonly readUrl: string;
          readonly issuedAt: string;
          readonly expiresAt: string;
        }>
      >()
      .mockRejectedValueOnce(new Error('synthetic transient failure'))
      .mockResolvedValueOnce({
        eventId: ids.event,
        mediaId: ids.media,
        readUrl: 'https://media.synthetic/photo.jpg',
        issuedAt: createdAt,
        expiresAt,
      });

    render(
      <TimelineEntryCard api={{ getMediaReadGrant }} projection={photo} />,
    );

    await screen.findByRole('button', { name: 'Retry loading photo' });
    fireEvent.press(
      screen.getByRole('button', { name: 'Retry loading photo' }),
    );
    await waitFor(() => expect(getMediaReadGrant).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Photo temporarily unavailable')).toBeNull();
  });

  test('offers explicit append-only correction and redaction controls with retained-history copy', () => {
    const visible = JournalEntryReadProjectionSchema.parse({
      visibility: 'visible',
      entry: {
        id: '10000000-0000-4000-8000-000000000013',
        eventId: ids.event,
        sequence: 4,
        kind: 'text',
        author: {
          kind: 'human',
          userId: ids.user,
          sessionId: ids.session,
        },
        authorDisplayName: null,
        source: 'mobile',
        serverTime: '2026-08-11T20:04:00.000Z',
        clientTime: null,
        payload: { text: 'Synthetic wording to correct' },
        supersedes: null,
      },
    });
    // Timeline entries carry no correct or redact controls on the phone; that
    // work happens in the web room.
    const card = render(<TimelineEntryCard projection={visible} />);
    expect(screen.queryByRole('button', { name: 'Correct…' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Redact…' })).toBeNull();
    card.unmount();

    const onSubmit = jest.fn();
    const correction = render(
      <JournalActionDialog
        action="correction"
        busy={false}
        error={null}
        onDismiss={() => undefined}
        onSubmit={onSubmit}
        target={visible}
      />,
    );
    expect(screen.getByText('Original entry retained')).toBeTruthy();
    expect(screen.getByText(/Nothing is rewritten or deleted/)).toBeTruthy();
    fireEvent.changeText(
      screen.getByLabelText('Corrected timeline text'),
      'Corrected synthetic wording',
    );
    fireEvent.changeText(
      screen.getByLabelText('Reason for correction'),
      'Fixed the synthetic wording',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Append correction' }));
    expect(onSubmit).toHaveBeenCalledWith({
      action: 'correction',
      reason: 'Fixed the synthetic wording',
      replacement: { kind: 'text', text: 'Corrected synthetic wording' },
    });
    correction.unmount();

    render(
      <JournalActionDialog
        action="redaction"
        busy={false}
        error={null}
        onDismiss={() => undefined}
        onSubmit={onSubmit}
        target={visible}
      />,
    );
    expect(
      screen.getByText(/The original record is kept and is never deleted/),
    ).toBeTruthy();
  });

  test('keeps immutable classification and event target visible in both full-screen composers', () => {
    const location = render(
      <LocationComposerDialog
        ambiguousLabel=""
        ambiguousReason=""
        busy={false}
        error={null}
        known={null}
        knownLabel=""
        mode="known"
        onAdjust={() => undefined}
        onAmbiguousLabelChange={() => undefined}
        onAmbiguousReasonChange={() => undefined}
        onCapture={() => undefined}
        onDismiss={() => undefined}
        onKnownLabelChange={() => undefined}
        onModeChange={() => undefined}
        onSubmit={() => undefined}
        onUnknownReasonChange={() => undefined}
        online
        target={target}
        templateMode="drill"
        unknownReason=""
        visible
      />,
    );
    expect(
      screen.getByLabelText(
        'DRILL — TRAINING ONLY. This is a drill for training. It is not a real incident.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Event target. Synthetic lockdown. Synthetic School, SYN. Classification and target are fixed.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Do not include student data\. Post only the precision/),
    ).toBeTruthy();
    location.unmount();

    const photo = render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: '',
            caption: null,
            stage: 'describe',
            progress: 0,
            error: null,
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto: async () => undefined,
          choosePhoto: async () => undefined,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit: async () => undefined,
          retry: async () => undefined,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="real"
        visible
      />,
    );
    expect(
      screen.getByLabelText(
        'REAL INCIDENT. This is a real incident. Staff notifications are not a drill.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Event target. Synthetic lockdown. Synthetic School, SYN. Classification and target are fixed.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Do not include student data\. Photos are untrusted input/,
      ),
    ).toBeTruthy();
    photo.unmount();

    render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: '',
            caption: null,
            stage: 'describe',
            progress: 0,
            error: null,
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto: async () => undefined,
          choosePhoto: async () => undefined,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit: async () => undefined,
          retry: async () => undefined,
          discard: async () => undefined,
        }}
        target={{ ...target, eventKind: 'test' }}
        templateMode="drill"
        visible
      />,
    );
    expect(
      screen.getByLabelText(
        'TEST — NOT A REAL INCIDENT. This is a synthetic delivery test. It is not a real incident.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('DRILL — TRAINING ONLY')).toBeNull();
  });

  test('labels capture and picker work without claiming a journal post is underway', () => {
    const location = render(
      <LocationComposerDialog
        ambiguousLabel=""
        ambiguousReason=""
        busy
        captureBusy
        error={null}
        known={null}
        knownLabel=""
        mode="known"
        onAdjust={() => undefined}
        onAmbiguousLabelChange={() => undefined}
        onAmbiguousReasonChange={() => undefined}
        onCapture={() => undefined}
        onDismiss={() => undefined}
        onKnownLabelChange={() => undefined}
        onModeChange={() => undefined}
        onSubmit={() => undefined}
        onUnknownReasonChange={() => undefined}
        online
        submitBusy={false}
        target={target}
        templateMode="drill"
        unknownReason=""
        visible
      />,
    );
    expect(screen.getByText('Capturing GPS…')).toBeTruthy();
    expect(screen.queryByText('Posting…')).toBeNull();
    location.unmount();

    render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: 'Synthetic description before picker return',
            caption: null,
            stage: 'describe',
            progress: 0,
            error: null,
            localCleanupOnly: false,
          },
          busy: true,
          takePhoto: async () => undefined,
          choosePhoto: async () => undefined,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit: async () => undefined,
          retry: async () => undefined,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="drill"
        visible
      />,
    );
    expect(screen.getByText('Working with photo…')).toBeTruthy();
    expect(screen.queryByText('Posting photo…')).toBeNull();
  });

  test('wires both native photo sources through explicit upload and retained retry actions', () => {
    const takePhoto = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const choosePhoto = jest
      .fn<() => Promise<void>>()
      .mockResolvedValue(undefined);
    const submit = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const retry = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const sourceSelection = render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: 'Synthetic source selection description',
            caption: null,
            stage: 'describe',
            progress: 0,
            error: null,
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto,
          choosePhoto,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit,
          retry,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="drill"
        visible
      />,
    );

    fireEvent.press(screen.getByRole('button', { name: 'Take Photo' }));
    fireEvent.press(
      screen.getByRole('button', { name: 'Choose Existing Photo' }),
    );
    expect(takePhoto).toHaveBeenCalledTimes(1);
    expect(choosePhoto).toHaveBeenCalledTimes(1);
    sourceSelection.unmount();

    const upload = render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: 'Validated synthetic selected photo',
            caption: null,
            stage: 'ready',
            progress: 0.2,
            error: null,
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto,
          choosePhoto,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit,
          retry,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="drill"
        visible
      />,
    );
    fireEvent.press(
      screen.getByRole('button', { name: 'Upload and post photo' }),
    );
    expect(submit).toHaveBeenCalledTimes(1);
    upload.unmount();

    render(
      <PhotoComposerDialog
        newPostsAllowed
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: 'Validated synthetic selected photo',
            caption: null,
            stage: 'failed',
            progress: 0.5,
            error: 'Synthetic interrupted upload',
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto,
          choosePhoto,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit,
          retry,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="drill"
        visible
      />,
    );
    fireEvent.press(
      screen.getByRole('button', { name: 'Retry retained draft' }),
    );
    expect(retry).toHaveBeenCalledTimes(1);
  });

  test('connects camera and library buttons to durable selection, submit, and explicit retry', async () => {
    const originalLoad = NativePhotoDraftStorage.prototype.load;
    const originalSave = NativePhotoDraftStorage.prototype.save;
    const originalDeleteManifest =
      NativePhotoDraftStorage.prototype.deleteManifest;
    const originalLoadComposer = NativePhotoDraftStorage.prototype.loadComposer;
    const originalSaveComposer = NativePhotoDraftStorage.prototype.saveComposer;
    const originalDeleteComposer =
      NativePhotoDraftStorage.prototype.deleteComposer;
    const originalLoadPending =
      NativePhotoDraftStorage.prototype.loadPendingSelection;
    const originalWithNewPending =
      NativePhotoDraftStorage.prototype.withNewPendingSelection;
    let stored: PhotoDraftManifest | null = null;
    const selectedSources: PhotoSource[] = [];
    const originalAppState = AppState.currentState;
    AppState.currentState = 'active';
    let uuidSequence = 0;
    const randomUuid = jest
      .spyOn(Crypto, 'randomUUID')
      .mockImplementation(
        () =>
          `40000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
      );

    const load = jest.fn(async () => stored);
    const save = jest.fn(
      async (next: PhotoDraftManifest, expected: PhotoDraftManifest | null) => {
        expect(stored).toEqual(expected);
        stored = next;
      },
    );
    const deleteManifest = jest.fn(async () => {
      stored = null;
    });
    NativePhotoDraftStorage.prototype.load = load;
    NativePhotoDraftStorage.prototype.save = save;
    NativePhotoDraftStorage.prototype.deleteManifest = deleteManifest;
    NativePhotoDraftStorage.prototype.loadComposer = jest.fn(async () => null);
    NativePhotoDraftStorage.prototype.saveComposer = jest.fn(
      async () => undefined,
    );
    NativePhotoDraftStorage.prototype.deleteComposer = jest.fn(
      async () => undefined,
    );
    NativePhotoDraftStorage.prototype.loadPendingSelection = jest.fn(
      async () => null,
    );
    async function withNewPendingSelection<Value>(
      owner: PendingPhotoSelectionOwner,
      operation: (lease: PendingPhotoSelectionLease) => Promise<Value>,
    ): Promise<Value> {
      return operation({
        owner,
        storage: { load, save, deleteManifest },
        select: async (source) => {
          selectedSources.push(source);
          return {
            localUri: `file:///documents/event-photo-drafts/${owner.draftId}.private-photo`,
            byteLength: 128,
            contentSha256: 'a'.repeat(64),
            declaredContentType: 'image/jpeg',
          };
        },
        recover: async () => null,
        clearBeforeCopy: async () => true,
        clearAfterCommittedManifest: async () => undefined,
      });
    }
    NativePhotoDraftStorage.prototype.withNewPendingSelection =
      withNewPendingSelection;

    try {
      for (const source of ['camera', 'library'] as const) {
        stored = null;
        const createMediaUploadIntent = jest.fn(async () => {
          throw new Error('synthetic interrupted intent request');
        });
        const rendered = render(
          <ConnectedPhotoComposerHarness
            api={{ createMediaUploadIntent } as unknown as EventRoomApi}
            onAppended={jest.fn()}
          />,
        );

        const description = await screen.findByLabelText(
          'Photo alternative text, required',
        );
        await waitFor(() => expect(description.props.editable).toBe(true));
        const altText = `Validated synthetic ${source} description`;
        fireEvent.changeText(description, altText);
        await waitFor(() =>
          expect(
            screen.getByLabelText('Photo alternative text, required').props
              .value,
          ).toBe(altText),
        );
        const sourceButton = screen.getByRole('button', {
          name: source === 'camera' ? 'Take Photo' : 'Choose Existing Photo',
        });
        await waitFor(() =>
          expect(sourceButton.props.accessibilityState).toEqual({
            disabled: false,
          }),
        );
        fireEvent.press(sourceButton);
        await screen.findByText('Stage: ready');
        expect(selectedSources.at(-1)).toBe(source);

        fireEvent.press(
          screen.getByRole('button', { name: 'Upload and post photo' }),
        );
        await screen.findByRole('button', {
          name: 'Retry retained draft',
        });
        expect(createMediaUploadIntent).toHaveBeenCalledTimes(1);
        fireEvent.press(
          screen.getByRole('button', { name: 'Retry retained draft' }),
        );
        await waitFor(() =>
          expect(createMediaUploadIntent).toHaveBeenCalledTimes(2),
        );
        expect(stored).toMatchObject({
          eventId: ids.event,
          sessionId: ids.session,
          stage: 'unknown',
          retryStage: 'create-intent',
        });
        rendered.unmount();
      }
      expect(selectedSources).toEqual(['camera', 'library']);
    } finally {
      NativePhotoDraftStorage.prototype.load = originalLoad;
      NativePhotoDraftStorage.prototype.save = originalSave;
      NativePhotoDraftStorage.prototype.deleteManifest = originalDeleteManifest;
      NativePhotoDraftStorage.prototype.loadComposer = originalLoadComposer;
      NativePhotoDraftStorage.prototype.saveComposer = originalSaveComposer;
      NativePhotoDraftStorage.prototype.deleteComposer = originalDeleteComposer;
      NativePhotoDraftStorage.prototype.loadPendingSelection =
        originalLoadPending;
      NativePhotoDraftStorage.prototype.withNewPendingSelection =
        originalWithNewPending;
      AppState.currentState = originalAppState;
      randomUuid.mockRestore();
    }
  });

  test('locks canonical descriptions after network start for failed and unknown drafts', () => {
    for (const stage of ['failed', 'unknown'] as const) {
      const setAltText = jest.fn();
      const setCaption = jest.fn();
      const rendered = render(
        <PhotoComposerDialog
          newPostsAllowed
          onDismiss={() => undefined}
          online
          photo={{
            draft: {
              altText: 'Canonical retained alternative text',
              caption: 'Canonical retained caption',
              stage,
              progress: 0.9,
              error: 'Synthetic retained draft',
              localCleanupOnly: false,
            },
            busy: false,
            takePhoto: async () => undefined,
            choosePhoto: async () => undefined,
            setAltText,
            setCaption,
            submit: async () => undefined,
            retry: async () => undefined,
            discard: async () => undefined,
          }}
          target={target}
          templateMode="drill"
          visible
        />,
      );

      expect(
        screen.getByLabelText('Photo alternative text, required').props
          .editable,
      ).toBe(false);
      expect(
        screen.getByLabelText('Optional photo caption').props.editable,
      ).toBe(false);
      expect(
        screen.getByDisplayValue('Canonical retained alternative text'),
      ).toBeTruthy();
      expect(
        screen.getByDisplayValue('Canonical retained caption'),
      ).toBeTruthy();
      expect(
        screen.getByText(/Photo description is locked after network work/),
      ).toBeTruthy();
      expect(setAltText).not.toHaveBeenCalled();
      expect(setCaption).not.toHaveBeenCalled();
      rendered.unmount();
    }
  });

  test('keeps closed-event photo recovery reachable without exposing upload or post', () => {
    const retry = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    render(
      <PhotoComposerDialog
        newPostsAllowed={false}
        onDismiss={() => undefined}
        online={false}
        photo={{
          draft: {
            altText: 'Retained closed-event description',
            caption: null,
            stage: 'unknown',
            progress: 0.9,
            error: 'Synthetic retained draft',
            localCleanupOnly: false,
          },
          busy: false,
          takePhoto: async () => undefined,
          choosePhoto: async () => undefined,
          setAltText: () => undefined,
          setCaption: () => undefined,
          submit: async () => undefined,
          retry,
          discard: async () => undefined,
        }}
        target={target}
        templateMode="real"
        visible
      />,
    );

    expect(screen.getByText('Recover photo draft')).toBeTruthy();
    expect(screen.queryByText('Take Photo')).toBeNull();
    expect(screen.queryByText('Choose Existing Photo')).toBeNull();
    expect(screen.queryByText('Upload and post photo')).toBeNull();
    fireEvent.press(screen.getByText('Reconcile with timeline'));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Discard retained photo draft')).toBeTruthy();
  });
});

describe('mobile event-room lifecycle confirmations', () => {
  test('shows the real all-clear recipients, consequences, channels, and canonical notification copy before exact-phrase confirmation', () => {
    const preview = lifecyclePreview('real');
    const onConfirm = jest.fn();
    render(
      <ConfirmationHarness
        action="all-clear"
        mode="real"
        onConfirm={onConfirm}
        preview={preview}
      />,
    );

    expect(
      screen.getByLabelText(
        'REAL INCIDENT. This is a real incident. Staff notifications are not a drill.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/42 staff get the all-clear below, and the event ends/),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'push. 42 people. Message: INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic push all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'email. 40 people. Message: INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic email all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic push all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic email all-clear instructions.',
      ),
    ).toBeTruthy();

    // The modal and its destructive button are the confirmation, exactly as
    // on the web room. There is no phrase to type.
    expect(screen.queryByTestId('lifecycle-confirmation-input')).toBeNull();
    expectConfirmationDisabled(false);
    fireEvent.press(screen.getByTestId('lifecycle-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('keeps drill wording unmistakable in both the banner and notification preview', () => {
    render(
      <ConfirmationHarness
        action="all-clear"
        mode="drill"
        onConfirm={() => undefined}
        preview={lifecyclePreview('drill')}
      />,
    );

    expect(
      screen.getByLabelText(
        'DRILL — TRAINING ONLY. This is a drill for training. It is not a real incident.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 staff get the all-clear below, and the event ends/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'DRILL: [DRILL] ALL CLEAR: Synthetic drill. [DRILL] Synthetic push all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/\[INCIDENT\]/)).toBeNull();
  });

  test('keeps test events distinct from drills in the room banner and lifecycle consequence', () => {
    render(
      <ConfirmationHarness
        action="all-clear"
        mode="drill"
        onConfirm={() => undefined}
        preview={lifecyclePreview('drill', false, 'test')}
      />,
    );

    expect(
      screen.getByLabelText(
        'TEST — NOT A REAL INCIDENT. This is a synthetic delivery test. It is not a real incident.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 staff get the all-clear below, and the event ends/),
    ).toBeTruthy();
    expect(screen.queryByText('DRILL — TRAINING ONLY')).toBeNull();
  });

  test('explains a blocked action without exposing raw server reason codes', () => {
    render(
      <ConfirmationHarness
        action="all-clear"
        mode="real"
        onConfirm={() => undefined}
        preview={lifecyclePreview('real', true)}
      />,
    );

    expect(
      screen.getByText(
        /cannot notify anyone right now.*Try again.*contact an administrator/su,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/PUSH_NOT_LIVE_VERIFIED/u)).toBeNull();
    expectConfirmationDisabled(true);
  });

  test('states that finishing the close notifies nobody else', () => {
    const onConfirm = jest.fn();
    render(
      <ConfirmationHarness
        action="close"
        mode="real"
        onConfirm={onConfirm}
        preview={null}
      />,
    );

    expect(
      screen.getByText(
        'This ends the event. Nobody else is notified. The timeline stays available.',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId('lifecycle-confirmation-input')).toBeNull();
    expectConfirmationDisabled(false);
    fireEvent.press(screen.getByTestId('lifecycle-confirm-button'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test('disables confirmation as soon as an all-clear preview expires', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(createdAt));
    try {
      const onConfirm = jest.fn();
      render(
        <ConfirmationHarness
          action="all-clear"
          mode="real"
          onConfirm={onConfirm}
          preview={lifecyclePreview('real')}
        />,
      );
      expectConfirmationDisabled(false);

      act(() => {
        jest.advanceTimersByTime(4 * 60 * 1_000 + 1);
      });

      expectConfirmationDisabled(true);
      expect(
        screen.getByText(
          'This check is out of date. Refresh it before ending the event.',
        ),
      ).toBeTruthy();
      fireEvent.press(screen.getByTestId('lifecycle-confirm-button'));
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
