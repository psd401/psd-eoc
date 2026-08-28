const BLOCKING_CHANNEL_NAMES: Readonly<Record<string, string>> = {
  EMAIL: 'Email',
  PUSH: 'Push notifications',
  SMS: 'Text messages',
};

function blockingChannelName(token: string): string {
  return BLOCKING_CHANNEL_NAMES[token] ?? token.toLowerCase();
}

/**
 * Says what an administrator has to change, in the words of the screen they
 * have to change it on.
 *
 * The preview already names every reason it refused. Only the generic sentence
 * was shown, so the answer to "why can I not start this drill" was a support
 * question rather than something the page answered. An unrecognised code is
 * still shown rather than hidden, because a reason nobody can read beats a
 * reason nobody can see.
 */
export function blockingReasonSentence(code: string): string {
  if (code === 'NO_RECIPIENTS') {
    return 'Nobody is on this site\u2019s roster. Add people to its building source under Schools, then publish the roster.';
  }
  const missingEndpoints = /^NO_([A-Z]+)_ENDPOINTS$/u.exec(code);
  if (missingEndpoints?.[1] !== undefined) {
    const token = missingEndpoints[1];
    if (token === 'PUSH') {
      return 'Nobody on this roster has registered a device for push notifications. Register one, then publish the roster again.';
    }
    if (token === 'EMAIL') {
      return 'Nobody on this roster has an email address.';
    }
    if (token === 'SMS') {
      return 'Nobody on this roster has a mobile number.';
    }
    return `Nobody on this roster can be reached by ${blockingChannelName(token).toLowerCase()}.`;
  }
  const disabled = /^([A-Z]+)_DISABLED$/u.exec(code);
  if (disabled?.[1] !== undefined) {
    return `${blockingChannelName(disabled[1])} is switched off. Turn it on under Notifications.`;
  }
  const notLiveVerified = /^([A-Z]+)_NOT_LIVE_VERIFIED$/u.exec(code);
  if (notLiveVerified?.[1] !== undefined) {
    return `${blockingChannelName(notLiveVerified[1])} has not been verified live. A roster of real staff is only notified through a verified channel.`;
  }
  const notMocked = /^([A-Z]+)_NOT_MOCKED$/u.exec(code);
  if (notMocked?.[1] !== undefined) {
    return `${blockingChannelName(notMocked[1])} is verified live, but this roster holds training recipients, which are only reached through a mock boundary.`;
  }
  return code;
}
