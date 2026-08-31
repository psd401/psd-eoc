'use client';

import {
  type ChannelConsequencePreview,
  type LifecycleConsequencePreview,
} from '@psd-eoc/contracts';
import { type ReactNode } from 'react';

import { blockingReasonSentence } from '../../../../lib/events/blocking-reasons';

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
    }>;

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
}: Readonly<{
  preview: LifecycleConsequencePreview;
}>) {
  const channelSummary = preview.channels
    .map((channel) => channel.channel.toLowerCase())
    .join(' and ');
  return (
    <section aria-labelledby="all-clear-audience-heading">
      <h3 id="all-clear-audience-heading">Who gets notified</h3>
      <p className="consequence-summary">
        <strong>{preview.recipientCount} staff</strong> by {channelSummary}.
      </p>
      {preview.channels.map((channel) => (
        <details className="channel-preview" key={channel.channel}>
          <summary>
            See the exact {channel.channel.toLowerCase()} message
          </summary>
          {renderedMessageContent(channel)}
        </details>
      ))}
      {preview.sendReadiness === 'blocked' ? (
        <div className="blocked-preview" role="alert">
          <strong>PSD EOC cannot notify anyone right now.</strong>
          <p>
            The event cannot be ended until this is fixed. Cancel, resolve what
            is listed below, and try again.
          </p>
          {preview.blockingReasonCodes.length > 0 ? (
            <ul>
              {preview.blockingReasonCodes.map((code) => (
                <li key={code}>{blockingReasonSentence(code)}</li>
              ))}
            </ul>
          ) : (
            <p>If it stays blocked, contact an administrator.</p>
          )}
        </div>
      ) : null}
    </section>
  );
}
