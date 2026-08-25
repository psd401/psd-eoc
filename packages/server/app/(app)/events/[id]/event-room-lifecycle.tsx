'use client';

import {
  type ChannelConsequencePreview,
  type LifecycleConsequencePreview,
} from '@psd-eoc/contracts';
import { type ReactNode } from 'react';

import { readableDateTime } from './event-room-timeline';

export type DialogState =
  | Readonly<{
      kind: 'correct';
      entryId: string;
      entrySequence: number;
    }>
  | Readonly<{
      kind: 'redact';
      entryId: string;
      entrySequence: number;
    }>
  | Readonly<{
      kind: 'all-clear';
      idempotencyKey: string;
      loading: boolean;
      preview: LifecycleConsequencePreview | null;
      error: string | null;
    }>
  | Readonly<{ kind: 'close' }>;

function renderedMessageContent(channel: ChannelConsequencePreview): ReactNode {
  const message = channel.renderedMessage;
  switch (message.channel) {
    case 'push':
      return (
        <>
          <p>
            <strong>Title:</strong> {message.title}
          </p>
          <p className="channel-copy">{message.body}</p>
        </>
      );
    case 'email':
      return (
        <>
          <p>
            <strong>Subject:</strong> {message.subject}
          </p>
          <p className="channel-copy">{message.textBody}</p>
        </>
      );
    case 'sms':
      return <p className="channel-copy">{message.body}</p>;
  }
}

export function PreviewDetails({
  preview,
  displayTimeZone,
}: Readonly<{
  preview: LifecycleConsequencePreview;
  displayTimeZone: string;
}>) {
  const channelSummary = preview.channels
    .map(
      (channel) =>
        `${channel.channel.toUpperCase()} (${channel.endpointCount} endpoint${
          channel.endpointCount === 1 ? '' : 's'
        })`,
    )
    .join(', ');
  return (
    <section aria-labelledby="all-clear-consequences-heading">
      <h3 id="all-clear-consequences-heading">Notification consequences</h3>
      <p className="consequence-summary">
        <strong>
          {preview.recipientCount} authorized recipients across{' '}
          {preview.channels.length} channels:
        </strong>{' '}
        {channelSummary}. Select “Issue all-clear and notify” to send the exact
        messages shown below and append the all-clear, or select “Cancel” to
        make no change.
      </p>
      {preview.channels.map((channel) => (
        <details className="channel-preview" key={channel.channel}>
          <summary>
            {channel.channel.toUpperCase()}: {channel.endpointCount} endpoints —{' '}
            {channel.integrationStatus.label}
          </summary>
          {renderedMessageContent(channel)}
        </details>
      ))}
      {preview.sendReadiness === 'blocked' ? (
        <div className="blocked-preview" role="alert">
          <strong>Sending is blocked.</strong>
          <p>
            The all-clear action remains unavailable until every recipient and
            channel consequence is ready. Cancel, correct the blocked
            configuration, and load a fresh preview.
          </p>
        </div>
      ) : null}
      <details className="technical-consequence-details">
        <summary>Technical consequence details</summary>
        <dl className="event-facts">
          <dt>Preview ID</dt>
          <dd>
            <code>{preview.id}</code>
          </dd>
          <dt>Event ID</dt>
          <dd>
            <code>{preview.eventId}</code>
          </dd>
          <dt>Event type version ID</dt>
          <dd>
            <code>{preview.eventTypeVersion.id}</code>
          </dd>
          <dt>Roster snapshot ID</dt>
          <dd>
            <code>{preview.rosterSnapshotId}</code>
          </dd>
          <dt>Consequence digest</dt>
          <dd>
            <code>{preview.consequenceDigest}</code>
          </dd>
          <dt>Preview expires</dt>
          <dd>
            <time dateTime={preview.expiresAt}>
              {readableDateTime(preview.expiresAt, displayTimeZone)}
            </time>
          </dd>
        </dl>
        <p>
          Roster population: <code>{preview.rosterPopulation}</code>
          {preview.rosterPopulation === 'synthetic'
            ? ' — provably unroutable training data.'
            : '.'}
        </p>
        {preview.blockingReasonCodes.length > 0 ? (
          <p role="alert">
            This action is unavailable because one or more server prerequisites
            are not ready. Refresh the preview; if it remains blocked, contact
            an administrator.
          </p>
        ) : null}
      </details>
    </section>
  );
}
