/** Pure policy kept separate so Bun can prove the OS fallback is never disabled. */
export const PSD_EOC_LOCAL_AUTH_POLICY = Object.freeze({
  promptMessage: 'Unlock PSD EOC',
  promptSubtitle: 'Use your biometric or device passcode',
  promptDescription:
    'Authenticate on this device to open your enrolled PSD EOC session.',
  cancelLabel: 'Cancel',
  biometricsSecurityLevel: 'strong' as const,
  disableDeviceFallback: false,
  fallbackLabel: 'Use Device Passcode',
  requireConfirmation: true,
});
