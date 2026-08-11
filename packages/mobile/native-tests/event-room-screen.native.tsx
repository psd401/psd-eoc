import {
  JournalEntryReadProjectionSchema,
  JournalEntrySchema,
  LifecycleConsequencePreviewSchema,
  projectJournalEntryForRead,
  type LifecycleConsequencePreview,
  type TemplateMode,
} from '@psd-eoc/contracts';
import { describe, expect, jest, test } from '@jest/globals';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { useState } from 'react';

import {
  LifecycleConfirmationDialog,
  LocationComposerDialog,
  PhotoComposerDialog,
  TimelineEntryCard,
} from '../src/features/event-room/event-room-screen';

const ids = {
  audience: '10000000-0000-4000-8000-000000000001',
  event: '10000000-0000-4000-8000-000000000002',
  eventType: '10000000-0000-4000-8000-000000000003',
  media: '10000000-0000-4000-8000-000000000004',
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

function lifecyclePreview(mode: TemplateMode): LifecycleConsequencePreview {
  const kind = mode === 'real' ? 'incident' : 'drill';
  const marker = mode === 'real' ? 'INCIDENT' : 'DRILL';
  return LifecycleConsequencePreviewSchema.parse({
    id: ids.preview,
    eventId: ids.event,
    purpose: 'all-clear',
    kind,
    templateMode: mode,
    eventTypeVersion: { id: ids.eventType, templateMode: mode },
    rosterSnapshotId: ids.roster,
    rosterPopulation: 'staff',
    audienceConfig: { id: ids.audience, version: 1 },
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
        integrationStatus: integrationStatus('push'),
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
        integrationStatus: integrationStatus('email'),
      },
    ],
    sendReadiness: 'ready',
    blockingReasonCodes: [],
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
  const [phrase, setPhrase] = useState('');
  return (
    <LifecycleConfirmationDialog
      action={action}
      busy={false}
      error={null}
      loadingPreview={false}
      mode={mode}
      onConfirm={onConfirm}
      onDismiss={() => undefined}
      onPhraseChange={setPhrase}
      onRefreshPreview={() => undefined}
      phrase={phrase}
      preview={preview}
      target={target}
      visible
    />
  );
}

function expectConfirmationDisabled(disabled: boolean): void {
  expect(
    screen.getByTestId('lifecycle-confirm-button').props.accessibilityState,
  ).toEqual({ disabled });
}

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
      'Content redacted. The original remains retained in the append-only journal.',
    );
    expect(JSON.stringify(redacted)).not.toContain('payload');
    expect(JSON.stringify(rendered.toJSON())).not.toContain(ids.media);
    expect(JSON.stringify(rendered.toJSON())).not.toContain(
      'PRIVATE SYNTHETIC PHOTO',
    );
    expect(getMediaReadGrant).not.toHaveBeenCalled();
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
        'DRILL — PRACTICE. This visual state is for a drill or synthetic test only.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Event target. Synthetic lockdown. Synthetic School, SYN. Classification and target are immutable.',
      ),
    ).toBeTruthy();
    location.unmount();

    render(
      <PhotoComposerDialog
        onDismiss={() => undefined}
        online
        photo={{
          draft: {
            altText: '',
            caption: null,
            stage: 'describe',
            progress: 0,
            error: null,
          },
          busy: false,
          selectPhoto: async () => undefined,
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
        'REAL INCIDENT. This visual state is reserved for a real incident.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'Event target. Synthetic lockdown. Synthetic School, SYN. Classification and target are immutable.',
      ),
    ).toBeTruthy();
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
        'REAL INCIDENT. This visual state is reserved for a real incident.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Recipients: 42')).toBeTruthy();
    expect(
      screen.getByText(
        /Consequence: change this event to all-clear and create a real incident all-clear notification/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'push. 42 endpoints. Integration live-verified. Message preview: INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic push all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByLabelText(
        'email. 40 endpoints. Integration live-verified. Message preview: INCIDENT: [INCIDENT] ALL CLEAR: Synthetic incident. [INCIDENT] Synthetic email all-clear instructions.',
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

    expectConfirmationDisabled(true);
    fireEvent.changeText(
      screen.getByTestId('lifecycle-confirmation-input'),
      'ALL CLEAR ',
    );
    expectConfirmationDisabled(true);
    fireEvent.changeText(
      screen.getByTestId('lifecycle-confirmation-input'),
      'ALL CLEAR',
    );
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
        'DRILL — PRACTICE. This visual state is for a drill or synthetic test only.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Consequence: change this event to all-clear and create a drill all-clear notification/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'DRILL: [DRILL] ALL CLEAR: Synthetic drill. [DRILL] Synthetic push all-clear instructions.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/\[INCIDENT\]/)).toBeNull();
  });

  test('uses the separate close phrase and states that close retains history without another notification', () => {
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
        'This closes the all-clear event record. Closing does not send another notification. The append-only timeline remains retained.',
      ),
    ).toBeTruthy();
    expectConfirmationDisabled(true);
    fireEvent.changeText(
      screen.getByTestId('lifecycle-confirmation-input'),
      'ALL CLEAR',
    );
    expectConfirmationDisabled(true);
    fireEvent.changeText(
      screen.getByTestId('lifecycle-confirmation-input'),
      'CLOSE EVENT',
    );
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
      fireEvent.changeText(
        screen.getByTestId('lifecycle-confirmation-input'),
        'ALL CLEAR',
      );
      expectConfirmationDisabled(false);

      act(() => {
        jest.advanceTimersByTime(4 * 60 * 1_000 + 1);
      });

      expectConfirmationDisabled(true);
      expect(
        screen.getByText(
          'This consequence preview expired. Fetch and review a fresh preview before confirming.',
        ),
      ).toBeTruthy();
      fireEvent.press(screen.getByTestId('lifecycle-confirm-button'));
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
