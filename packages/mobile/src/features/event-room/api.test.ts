import { describe, expect, test } from 'bun:test';

import type {
  AuthenticatedRequestOptions,
  RequestAuthenticated,
} from '../../lib/api';
import { EventRoomApi } from './api';

const IDS = Object.freeze({
  actor: '00000000-0000-4000-8000-000000000001',
  session: '00000000-0000-4000-8000-000000000002',
  request: '00000000-0000-4000-8000-000000000003',
  facility: '00000000-0000-4000-8000-000000000004',
  audience: '00000000-0000-4000-8000-000000000005',
  roster: '00000000-0000-4000-8000-000000000006',
  eventTypeVersion: '00000000-0000-4000-8000-000000000007',
  event: '00000000-0000-4000-8000-000000000008',
  textEntry: '00000000-0000-4000-8000-000000000009',
  locationEntry: '00000000-0000-4000-8000-000000000010',
  photoEntry: '00000000-0000-4000-8000-000000000011',
  agent: '00000000-0000-4000-8000-000000000012',
  apiKey: '00000000-0000-4000-8000-000000000013',
  activationPreview: '00000000-0000-4000-8000-000000000014',
  lifecyclePreview: '00000000-0000-4000-8000-000000000015',
  otherLifecyclePreview: '00000000-0000-4000-8000-000000000023',
  transition: '00000000-0000-4000-8000-000000000016',
  intent: '00000000-0000-4000-8000-000000000017',
  allClearEntry: '00000000-0000-4000-8000-000000000018',
  intentEntry: '00000000-0000-4000-8000-000000000019',
  closeEntry: '00000000-0000-4000-8000-000000000020',
  mediaUploadIntent: '00000000-0000-4000-8000-000000000021',
  media: '00000000-0000-4000-8000-000000000022',
});

const TIMES = Object.freeze({
  created: '2026-08-11T16:00:00.000Z',
  activated: '2026-08-11T16:01:00.000Z',
  allClear: '2026-08-11T16:02:00.000Z',
  closed: '2026-08-11T16:03:00.000Z',
  expires: '2026-08-11T16:10:00.000Z',
});

const HUMAN_ACTOR = Object.freeze({
  kind: 'human' as const,
  userId: IDS.actor,
  sessionId: IDS.session,
});

const AGENT_ACTOR = Object.freeze({
  kind: 'agent' as const,
  agentId: IDS.agent,
  apiKeyId: IDS.apiKey,
});

const TARGETING = Object.freeze({
  kind: 'test' as const,
  templateMode: 'drill' as const,
  rosterPopulation: 'synthetic' as const,
});

const EVENT_TYPE_VERSION = Object.freeze({
  id: IDS.eventTypeVersion,
  templateMode: 'drill' as const,
});

const ALL_CLEAR_TRANSITION_EVIDENCE_KEY = 'a'.repeat(64);
const CLOSE_TRANSITION_EVIDENCE_KEY = 'c'.repeat(64);

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

function requestHarness(...responses: readonly unknown[]) {
  const calls: CapturedRequest[] = [];
  let responseIndex = 0;
  const request: RequestAuthenticated = async <Output>(
    options: AuthenticatedRequestOptions<Output>,
  ): Promise<Output> => {
    if (responseIndex >= responses.length) {
      throw new Error('No synthetic response remains for this request.');
    }
    calls.push({
      method: options.method,
      path: options.path,
      ...('body' in options ? { body: options.body } : {}),
      ...('idempotencyKey' in options
        ? { idempotencyKey: options.idempotencyKey }
        : {}),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const response = responses[responseIndex];
    responseIndex += 1;
    return options.schema.parse(response);
  };
  return { api: new EventRoomApi(request), calls };
}

function activeSyntheticEvent() {
  return {
    id: IDS.event,
    facilityId: IDS.facility,
    kind: 'test',
    templateMode: 'drill',
    eventTypeVersion: EVENT_TYPE_VERSION,
    status: 'active',
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    createdBy: AGENT_ACTOR,
    createdAt: TIMES.created,
    activatedAt: TIMES.activated,
    allClearAt: null,
    reactivatedAt: null,
    closedAt: null,
    correctionOfEventId: null,
    correctionReason: null,
    activationAuthorization: {
      kind: 'synthetic-training',
      activationPreviewId: IDS.activationPreview,
      consequenceDigest: 'a'.repeat(64),
      requestId: IDS.request,
    },
  } as const;
}

function trustedHeader() {
  return {
    facility: {
      id: IDS.facility,
      code: 'SYN-NORTH',
      name: 'Synthetic North School',
    },
    eventType: {
      id: IDS.eventTypeVersion,
      name: 'Synthetic Drill',
      templateMode: 'drill',
    },
  } as const;
}

function journalEntry(kind: 'text' | 'location' | 'photo', sequence: number) {
  const common = {
    eventId: IDS.event,
    sequence,
    author: HUMAN_ACTOR,
    source: 'mobile' as const,
    serverTime: TIMES.allClear,
    clientTime: TIMES.activated,
    supersedes: null,
  };
  switch (kind) {
    case 'text':
      return {
        ...common,
        id: IDS.textEntry,
        kind,
        payload: { text: 'Synthetic room update.' },
      } as const;
    case 'location':
      return {
        ...common,
        id: IDS.locationEntry,
        kind,
        payload: {
          state: 'known',
          latitude: 47.387,
          longitude: -122.592,
          accuracyMeters: 12,
          label: 'Synthetic north entrance',
        },
      } as const;
    case 'photo':
      return {
        ...common,
        id: IDS.photoEntry,
        kind,
        payload: {
          mediaId: IDS.media,
          altText: 'Synthetic staging area with no people visible',
          caption: null,
        },
      } as const;
  }
}

function mockedIntegration(channel: 'push' | 'email') {
  return {
    integrationId: channel === 'push' ? 'expo-push' : 'ses-email',
    label: 'mocked',
    verifiedAt: null,
    verifiedByUserId: null,
    authorizationReference: null,
    reasonCode: null,
    observedAt: TIMES.created,
  } as const;
}

function channelPlan() {
  return [
    {
      channel: 'push',
      endpointCount: 3,
      renderedMessage: {
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'all-clear',
        classificationMarker: 'DRILL',
        channel: 'push',
        title: '[DRILL] Synthetic drill all clear',
        body: '[DRILL] The synthetic drill is all clear.',
      },
      integrationStatus: mockedIntegration('push'),
    },
    {
      channel: 'email',
      endpointCount: 3,
      renderedMessage: {
        eventKind: 'test',
        templateMode: 'drill',
        purpose: 'all-clear',
        classificationMarker: 'DRILL',
        channel: 'email',
        subject: '[DRILL] Synthetic drill all clear',
        textBody: '[DRILL] The synthetic drill is all clear.',
      },
      integrationStatus: mockedIntegration('email'),
    },
  ] as const;
}

function lifecyclePreview() {
  return {
    id: IDS.lifecyclePreview,
    eventId: IDS.event,
    purpose: 'all-clear',
    ...TARGETING,
    eventTypeVersion: EVENT_TYPE_VERSION,
    rosterSnapshotId: IDS.roster,
    recipientCount: 3,
    channels: channelPlan(),
    sendReadiness: 'ready',
    blockingReasonCodes: [],
    consequenceDigest: 'b'.repeat(64),
    createdAt: TIMES.allClear,
    expiresAt: TIMES.expires,
  } as const;
}

function allClearResult(
  transitionEvidenceKey: string = ALL_CLEAR_TRANSITION_EVIDENCE_KEY,
  lifecyclePreviewId: string = IDS.lifecyclePreview,
) {
  const authorization = {
    kind: 'synthetic-lifecycle',
    purpose: 'all-clear',
    targeting: TARGETING,
    lifecyclePreviewId,
    transitionId: IDS.transition,
    consequenceDigest: 'b'.repeat(64),
    requestId: IDS.request,
  } as const;
  const transition = {
    id: IDS.transition,
    sequence: 2,
    actor: HUMAN_ACTOR,
    source: 'mobile',
    occurredAt: TIMES.allClear,
    requestId: IDS.request,
    confirmationId: null,
    consequenceDigest: null,
    targeting: TARGETING,
    idempotencyKey: transitionEvidenceKey,
    transition: 'all-clear',
    eventId: IDS.event,
    from: 'active',
    to: 'all-clear',
    notificationAuthorization: authorization,
  } as const;
  const notificationIntent = {
    id: IDS.intent,
    eventId: IDS.event,
    eventKind: 'test',
    templateMode: 'drill',
    purpose: 'all-clear',
    eventTypeVersion: EVENT_TYPE_VERSION,
    rosterSnapshotId: IDS.roster,
    rosterPopulation: 'synthetic',
    createdBy: HUMAN_ACTOR,
    source: 'mobile',
    requestId: IDS.request,
    authorization,
    channels: channelPlan(),
    createdAt: TIMES.allClear,
  } as const;
  return {
    event: {
      ...activeSyntheticEvent(),
      status: 'all-clear',
      allClearAt: TIMES.allClear,
    },
    transition,
    journalEntries: [
      {
        id: IDS.allClearEntry,
        eventId: IDS.event,
        sequence: 2,
        kind: 'system',
        author: HUMAN_ACTOR,
        source: 'mobile',
        serverTime: TIMES.allClear,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'all-clear-issued',
          summary: 'Synthetic drill is all clear.',
          transition,
        },
      },
      {
        id: IDS.intentEntry,
        eventId: IDS.event,
        sequence: 3,
        kind: 'system',
        author: HUMAN_ACTOR,
        source: 'mobile',
        serverTime: TIMES.allClear,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'notification-intent-recorded',
          summary: 'Synthetic all-clear notification intent recorded.',
          relatedRecordId: IDS.intent,
        },
      },
    ],
    notificationIntent,
    preparedActivationConsumption: null,
  } as const;
}

function closeResult(
  transitionEvidenceKey: string = CLOSE_TRANSITION_EVIDENCE_KEY,
) {
  const transition = {
    id: IDS.transition,
    sequence: 3,
    actor: HUMAN_ACTOR,
    source: 'mobile',
    occurredAt: TIMES.closed,
    requestId: IDS.request,
    confirmationId: null,
    consequenceDigest: null,
    targeting: TARGETING,
    idempotencyKey: transitionEvidenceKey,
    transition: 'close',
    eventId: IDS.event,
    from: 'all-clear',
    to: 'closed',
  } as const;
  return {
    event: {
      ...activeSyntheticEvent(),
      status: 'closed',
      allClearAt: TIMES.allClear,
      closedAt: TIMES.closed,
    },
    transition,
    journalEntries: [
      {
        id: IDS.closeEntry,
        eventId: IDS.event,
        sequence: 4,
        kind: 'system',
        author: HUMAN_ACTOR,
        source: 'mobile',
        serverTime: TIMES.closed,
        clientTime: null,
        supersedes: null,
        payload: {
          code: 'event-closed',
          summary: 'Synthetic drill event closed.',
          transition,
        },
      },
    ],
    notificationIntent: null,
    preparedActivationConsumption: null,
  } as const;
}

function uploadIntent() {
  return {
    id: IDS.mediaUploadIntent,
    eventId: IDS.event,
    byteLength: 1_024,
    contentSha256: 'c'.repeat(64),
    declaredContentType: 'image/jpeg',
    uploadMethod: 'PUT',
    uploadUrl: 'https://media.synthetic.example/upload/signed-intent',
    status: 'pending-upload',
    createdAt: TIMES.created,
    expiresAt: TIMES.expires,
  } as const;
}

function mediaRecord() {
  return {
    id: IDS.media,
    uploadIntentId: IDS.mediaUploadIntent,
    eventId: IDS.event,
    status: 'ready',
    detectedContentType: 'image/jpeg',
    sanitizedByteLength: 900,
    sanitizedContentSha256: 'd'.repeat(64),
    malwareScan: 'clean',
    exifStripped: true,
    createdAt: TIMES.activated,
  } as const;
}

function readGrant() {
  return {
    eventId: IDS.event,
    mediaId: IDS.media,
    readUrl: 'https://media.synthetic.example/read/signed-object',
    issuedAt: TIMES.activated,
    expiresAt: TIMES.allClear,
  } as const;
}

describe('mobile event-room API', () => {
  test('sync encodes an opaque cursor and parses the canonical trusted header', async () => {
    const response = {
      eventId: IDS.event,
      header: trustedHeader(),
      event: activeSyntheticEvent(),
      entries: [],
      cursor: 'opaque_cursor_2',
      hasMore: false,
      snapshotSequence: 0,
    } as const;
    const { api, calls } = requestHarness(response);
    const signal = new AbortController().signal;

    const result = await api.sync(
      IDS.event,
      'opaque cursor/with?reserved&parts',
      signal,
    );

    expect(calls).toEqual([
      {
        method: 'GET',
        path: `/events/${IDS.event}/api?cursor=opaque%20cursor%2Fwith%3Freserved%26parts`,
        signal,
      },
    ]);
    expect(result.header).toEqual(trustedHeader());
    expect(result.event?.eventTypeVersion.templateMode).toBe('drill');
    expect(result.cursor).toBe('opaque_cursor_2');
  });

  test('text, location, and photo operations share one event route and preserve caller idempotency', async () => {
    const text = journalEntry('text', 1);
    const location = journalEntry('location', 2);
    const photo = journalEntry('photo', 3);
    const { api, calls } = requestHarness(
      { entry: text },
      { entry: location },
      { entry: photo },
    );
    const signal = new AbortController().signal;
    const locationPayload = {
      state: 'known' as const,
      latitude: 47.387,
      longitude: -122.592,
      accuracyMeters: 12,
      label: 'Synthetic north entrance',
    };

    const textResult = await api.postText(
      IDS.event,
      IDS.session,
      'Synthetic room update.',
      'caller-text-key-0001',
      TIMES.activated,
      signal,
    );
    const locationResult = await api.postLocation(
      IDS.event,
      IDS.session,
      locationPayload,
      'caller-location-key-0001',
      TIMES.activated,
      signal,
    );
    const photoResult = await api.postPhoto(
      IDS.event,
      IDS.session,
      IDS.media,
      'Synthetic staging area with no people visible',
      null,
      'caller-photo-key-0001',
      TIMES.activated,
      signal,
    );

    const sharedPath = `/events/${IDS.event}/api`;
    expect(calls).toEqual([
      {
        method: 'POST',
        path: sharedPath,
        body: {
          operation: 'post-text',
          text: 'Synthetic room update.',
          clientTime: TIMES.activated,
        },
        idempotencyKey: 'caller-text-key-0001',
        signal,
      },
      {
        method: 'POST',
        path: sharedPath,
        body: {
          operation: 'post-location',
          payload: locationPayload,
          clientTime: TIMES.activated,
        },
        idempotencyKey: 'caller-location-key-0001',
        signal,
      },
      {
        method: 'POST',
        path: sharedPath,
        body: {
          operation: 'post-photo',
          mediaId: IDS.media,
          altText: 'Synthetic staging area with no people visible',
          caption: null,
          clientTime: TIMES.activated,
        },
        idempotencyKey: 'caller-photo-key-0001',
        signal,
      },
    ]);
    expect(textResult).toEqual({ visibility: 'visible', entry: text });
    expect(locationResult).toEqual({
      visibility: 'visible',
      entry: location,
    });
    expect(photoResult).toEqual({ visibility: 'visible', entry: photo });
  });

  test('rejects canonical same-event journal responses for another requested payload', async () => {
    const wrongText = requestHarness({
      entry: {
        ...journalEntry('text', 1),
        payload: { text: 'A different valid update.' },
      },
    });
    await expect(
      wrongText.api.postText(
        IDS.event,
        IDS.session,
        'Synthetic room update.',
        'caller-text-key-0003',
        TIMES.activated,
      ),
    ).rejects.toThrow('another request');

    const wrongPhoto = requestHarness({
      entry: {
        ...journalEntry('photo', 3),
        payload: {
          ...journalEntry('photo', 3).payload,
          mediaId: IDS.facility,
        },
      },
    });
    await expect(
      wrongPhoto.api.postPhoto(
        IDS.event,
        IDS.session,
        IDS.media,
        'Synthetic staging area with no people visible',
        null,
        'caller-photo-key-0003',
        TIMES.activated,
      ),
    ).rejects.toThrow('another request');
  });

  test('rejects a mutation echo attributed to another authenticated session', async () => {
    const wrongSession = requestHarness({
      entry: {
        ...journalEntry('text', 1),
        author: {
          ...HUMAN_ACTOR,
          sessionId: IDS.facility,
        },
      },
    });

    await expect(
      wrongSession.api.postText(
        IDS.event,
        IDS.session,
        'Synthetic room update.',
        'caller-text-key-session-bound',
        TIMES.activated,
      ),
    ).rejects.toThrow('another request');
  });

  test('media intent, completion, and read paths parse their canonical schemas', async () => {
    const intent = uploadIntent();
    const media = mediaRecord();
    const grant = readGrant();
    const { api, calls } = requestHarness(intent, media, grant);
    const signal = new AbortController().signal;
    const input = {
      eventId: IDS.event,
      byteLength: 1_024,
      contentSha256: 'c'.repeat(64),
      declaredContentType: 'image/jpeg' as const,
    };

    await expect(
      api.createMediaUploadIntent(
        input,
        'caller-media-intent-key-0001',
        signal,
      ),
    ).resolves.toEqual(intent);
    await expect(
      api.completeMediaUpload(
        IDS.mediaUploadIntent,
        'caller-media-complete-key-0001',
        signal,
      ),
    ).resolves.toEqual(media);
    await expect(
      api.getMediaReadGrant(IDS.event, IDS.media, signal),
    ).resolves.toEqual(grant);

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/media/upload-intents',
        body: input,
        idempotencyKey: 'caller-media-intent-key-0001',
        signal,
      },
      {
        method: 'POST',
        path: `/api/media/upload-intents/${IDS.mediaUploadIntent}/complete`,
        idempotencyKey: 'caller-media-complete-key-0001',
        signal,
      },
      {
        method: 'GET',
        path: `/api/media/events/${IDS.event}/${IDS.media}/read-grant`,
        signal,
      },
    ]);
  });

  test('cross-binds canonical media responses to the exact request', async () => {
    const wrongIntent = requestHarness({
      ...uploadIntent(),
      eventId: IDS.facility,
    });
    await expect(
      wrongIntent.api.createMediaUploadIntent(
        {
          eventId: IDS.event,
          byteLength: 1_024,
          contentSha256: 'c'.repeat(64),
          declaredContentType: 'image/jpeg',
        },
        'caller-media-intent-key-0003',
      ),
    ).rejects.toThrow('another photo upload intent');

    const wrongCompletion = requestHarness({
      ...mediaRecord(),
      uploadIntentId: IDS.facility,
    });
    await expect(
      wrongCompletion.api.completeMediaUpload(
        IDS.mediaUploadIntent,
        'caller-media-complete-key-0003',
      ),
    ).rejects.toThrow('another photo upload');

    const wrongGrant = requestHarness({
      ...readGrant(),
      eventId: IDS.facility,
    });
    await expect(
      wrongGrant.api.getMediaReadGrant(IDS.event, IDS.media),
    ).rejects.toThrow('another photo read grant');
  });

  test('all-clear preview uses the shared route and its wrapped canonical schema', async () => {
    const preview = lifecyclePreview();
    const { api, calls } = requestHarness({ preview });

    await expect(
      api.previewAllClear(IDS.event, 'caller-preview-key-0001', undefined),
    ).resolves.toEqual(preview);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/events/${IDS.event}/api`,
        body: { operation: 'preview-all-clear' },
        idempotencyKey: 'caller-preview-key-0001',
      },
    ]);
  });

  test('lifecycle adapters strip response aliases and retain canonical all-clear and close truth', async () => {
    const allClear = allClearResult();
    const closed = closeResult();
    const { api, calls } = requestHarness(
      {
        ...allClear,
        entries: allClear.journalEntries,
        transitionIdempotencyKey: allClear.transition.idempotencyKey,
        result: allClear,
      },
      {
        ...closed,
        entries: closed.journalEntries,
        transitionIdempotencyKey: closed.transition.idempotencyKey,
        result: closed,
      },
    );

    const allClearResultValue = await api.allClear(
      IDS.event,
      IDS.lifecyclePreview,
      'ALL CLEAR',
      'caller-all-clear-key-0001',
    );
    const closeResultValue = await api.close(
      IDS.event,
      'CLOSE EVENT',
      'caller-close-key-0001',
    );

    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/events/${IDS.event}/api`,
        body: {
          operation: 'all-clear',
          lifecyclePreviewId: IDS.lifecyclePreview,
          confirmationPhrase: 'ALL CLEAR',
        },
        idempotencyKey: 'caller-all-clear-key-0001',
      },
      {
        method: 'POST',
        path: `/events/${IDS.event}/api`,
        body: {
          operation: 'close',
          confirmationPhrase: 'CLOSE EVENT',
        },
        idempotencyKey: 'caller-close-key-0001',
      },
    ]);
    expect(Object.keys(allClearResultValue).sort()).toEqual(
      [
        'event',
        'journalEntries',
        'notificationIntent',
        'preparedActivationConsumption',
        'transition',
      ].sort(),
    );
    expect(allClearResultValue.notificationIntent).not.toBeNull();
    expect('entries' in allClearResultValue).toBe(false);
    expect('result' in allClearResultValue).toBe(false);
    expect(Object.keys(closeResultValue).sort()).toEqual(
      [
        'event',
        'journalEntries',
        'notificationIntent',
        'preparedActivationConsumption',
        'transition',
      ].sort(),
    );
    expect(closeResultValue.notificationIntent).toBeNull();
    expect('transitionIdempotencyKey' in closeResultValue).toBe(false);
  });

  test('rejects lifecycle results for another preview or unscoped transition evidence', async () => {
    const wrongPreview = requestHarness(
      allClearResult(
        ALL_CLEAR_TRANSITION_EVIDENCE_KEY,
        IDS.otherLifecyclePreview,
      ),
    );
    await expect(
      wrongPreview.api.allClear(
        IDS.event,
        IDS.lifecyclePreview,
        'ALL CLEAR',
        'caller-all-clear-key-0003',
      ),
    ).rejects.toThrow('another event');

    const rawAllClearKey = requestHarness(
      allClearResult('caller-all-clear-key-0003'),
    );
    await expect(
      rawAllClearKey.api.allClear(
        IDS.event,
        IDS.lifecyclePreview,
        'ALL CLEAR',
        'caller-all-clear-key-0003',
      ),
    ).rejects.toThrow('another event');

    const rawCloseKey = requestHarness(closeResult('caller-close-key-0003'));
    await expect(
      rawCloseKey.api.close(IDS.event, 'CLOSE EVENT', 'caller-close-key-0003'),
    ).rejects.toThrow('another event');
  });

  test('fails closed when all-clear omits the send or close invents one', async () => {
    const allClear = allClearResult();
    const missingIntent = requestHarness({
      ...allClear,
      notificationIntent: null,
    });
    await expect(
      missingIntent.api.allClear(
        IDS.event,
        IDS.lifecyclePreview,
        'ALL CLEAR',
        'caller-all-clear-key-0002',
      ),
    ).rejects.toThrow();

    const closed = closeResult();
    const inventedIntent = requestHarness({
      ...closed,
      notificationIntent: allClear.notificationIntent,
    });
    await expect(
      inventedIntent.api.close(
        IDS.event,
        'CLOSE EVENT',
        'caller-close-key-0002',
      ),
    ).rejects.toThrow();
  });

  test('rejects malformed sync, journal, preview, and media responses', async () => {
    const sync = requestHarness({
      eventId: IDS.event,
      header: {
        ...trustedHeader(),
        eventType: { ...trustedHeader().eventType, templateMode: 'real' },
      },
      event: activeSyntheticEvent(),
      entries: [],
      cursor: 'opaque_cursor_2',
      hasMore: false,
      snapshotSequence: 0,
    });
    await expect(sync.api.sync(IDS.event, null)).rejects.toThrow();

    const malformedJournal = requestHarness({
      entry: {
        ...journalEntry('text', 1),
        payload: { text: '' },
      },
    });
    await expect(
      malformedJournal.api.postText(
        IDS.event,
        IDS.session,
        'Synthetic room update.',
        'caller-text-key-0002',
        null,
      ),
    ).rejects.toThrow();

    const preview = lifecyclePreview();
    const malformedPreview = requestHarness({
      preview: { ...preview, purpose: 'reactivation' },
    });
    await expect(
      malformedPreview.api.previewAllClear(
        IDS.event,
        'caller-preview-key-0002',
      ),
    ).rejects.toThrow();

    const malformedIntent = requestHarness({
      ...uploadIntent(),
      uploadUrl: 'http://media.synthetic.example/not-private',
    });
    await expect(
      malformedIntent.api.createMediaUploadIntent(
        {
          eventId: IDS.event,
          byteLength: 1_024,
          contentSha256: 'c'.repeat(64),
          declaredContentType: 'image/jpeg',
        },
        'caller-media-intent-key-0002',
      ),
    ).rejects.toThrow();

    const malformedMedia = requestHarness({
      ...mediaRecord(),
      exifStripped: false,
    });
    await expect(
      malformedMedia.api.completeMediaUpload(
        IDS.mediaUploadIntent,
        'caller-media-complete-key-0002',
      ),
    ).rejects.toThrow();

    const malformedGrant = requestHarness({
      ...readGrant(),
      readUrl: 'http://media.synthetic.example/not-private',
    });
    await expect(
      malformedGrant.api.getMediaReadGrant(IDS.event, IDS.media),
    ).rejects.toThrow();
  });
});
