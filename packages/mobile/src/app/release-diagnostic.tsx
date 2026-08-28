import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  readLaunchedUpdateDiagnostic,
  type LaunchedUpdateDiagnostic,
} from '../lib/release/update-diagnostic';

interface DiagnosticRowProps {
  readonly label: string;
  readonly value: string;
  readonly selectable?: boolean;
}

function DiagnosticRow({
  label,
  selectable = false,
  value,
}: DiagnosticRowProps) {
  return (
    <View
      accessibilityLabel={`${label}: ${value}`}
      accessibilityRole="text"
      style={styles.row}
    >
      <Text importantForAccessibility="no" style={styles.rowLabel}>
        {label}
      </Text>
      <Text
        importantForAccessibility="no"
        selectable={selectable}
        style={styles.rowValue}
      >
        {value}
      </Text>
    </View>
  );
}

function statusLabel(diagnostic: LaunchedUpdateDiagnostic): string {
  return diagnostic.status === 'known'
    ? 'Identity available'
    : 'Unknown — do not use as release evidence';
}

function launchSourceLabel(diagnostic: LaunchedUpdateDiagnostic): string {
  switch (diagnostic.launchSource) {
    case 'embedded':
      return 'Embedded in this installed binary';
    case 'unknown':
      return 'Unknown';
  }
}

function remoteUpdatesLabel(diagnostic: LaunchedUpdateDiagnostic): string {
  return diagnostic.mode === 'embedded-only'
    ? 'Disabled — embedded store bundle only'
    : 'Unknown — stop release verification';
}

function remoteIdentityLabel(diagnostic: LaunchedUpdateDiagnostic): string {
  return diagnostic.mode === 'embedded-only'
    ? 'Not applicable — remote updates disabled'
    : 'Unknown';
}

function emergencyLaunchLabel(diagnostic: LaunchedUpdateDiagnostic): string {
  if (diagnostic.isEmergencyLaunch === null) return 'Unknown';
  return diagnostic.isEmergencyLaunch ? 'Yes — stop verification' : 'No';
}

export default function ReleaseDiagnosticScreen() {
  const diagnostic = readLaunchedUpdateDiagnostic();

  return (
    <SafeAreaView edges={['left', 'right', 'bottom']} style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        style={styles.page}
      >
        <View style={styles.heading}>
          <Text style={styles.eyebrow}>DISTRICT TECHNOLOGY</Text>
          <Text accessibilityRole="header" style={styles.title}>
            Release diagnostics
          </Text>
          <Text style={styles.subtitle}>
            Use this read-only identity after a cold launch of a physical
            TestFlight or Google Play installation approved for release
            verification.
          </Text>
        </View>

        <View accessibilityRole="summary" style={styles.safetyNotice}>
          <Text style={styles.safetyTitle}>Read-only device evidence</Text>
          <Text style={styles.safetyBody}>
            This screen cannot check for, download, apply, or publish an update.
            It cannot start an incident, send a notification, issue an
            all-clear, or close an event.
          </Text>
        </View>

        {diagnostic.status === 'unknown' ? (
          <View
            accessibilityLiveRegion="assertive"
            accessibilityRole="alert"
            style={styles.warning}
          >
            <Text style={styles.warningTitle}>
              This build could not be confirmed
            </Text>
            <Text style={styles.warningBody}>
              Stop and contact District Technology. Do not assume which build is
              installed from the store listing alone.
            </Text>
            {diagnostic.unmetConditions.map((reason) => (
              <Text key={reason} style={styles.warningBody}>
                {reason}
              </Text>
            ))}
          </View>
        ) : null}

        {diagnostic.isEmergencyLaunch === true ? (
          <View accessibilityRole="alert" style={styles.warning}>
            <Text style={styles.warningTitle}>
              Emergency fallback is active
            </Text>
            <Text style={styles.warningBody}>
              Stop release verification and contact District Technology before
              exposing this build to more testers.
            </Text>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text accessibilityRole="header" style={styles.cardTitle}>
            Installed release identity
          </Text>
          <DiagnosticRow
            label="Evidence status"
            value={statusLabel(diagnostic)}
          />
          <DiagnosticRow
            label="Application ID"
            selectable
            value={diagnostic.applicationId ?? 'Unknown'}
          />
          <DiagnosticRow
            label="Application version"
            selectable
            value={diagnostic.applicationVersion ?? 'Unknown'}
          />
          <DiagnosticRow
            label="Native build version"
            selectable
            value={diagnostic.nativeBuildVersion ?? 'Unknown'}
          />
          <DiagnosticRow
            label="Remote updates"
            value={remoteUpdatesLabel(diagnostic)}
          />
          <DiagnosticRow
            label="Launch source"
            value={launchSourceLabel(diagnostic)}
          />
          <DiagnosticRow
            label="Remote update ID"
            selectable
            value={diagnostic.updateId ?? remoteIdentityLabel(diagnostic)}
          />
          <DiagnosticRow
            label="Configured runtime version"
            selectable
            value={
              diagnostic.configuredRuntimeVersion ??
              remoteIdentityLabel(diagnostic)
            }
          />
          <DiagnosticRow
            label="Remote update channel"
            selectable
            value={diagnostic.channel ?? remoteIdentityLabel(diagnostic)}
          />
          <DiagnosticRow
            label="Emergency launch"
            value={emergencyLaunchLabel(diagnostic)}
          />
        </View>

        <Text accessibilityRole="summary" style={styles.footer}>
          Record these values only in the approved private release record. Do
          not include staff identities, device identifiers, credentials, or
          provider responses.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFFFFF',
    borderColor: '#BCCCDC',
    borderRadius: 18,
    borderWidth: 1,
    gap: 14,
    padding: 18,
  },
  cardTitle: {
    color: '#102A43',
    fontSize: 21,
    fontWeight: '900',
    lineHeight: 28,
  },
  content: {
    gap: 18,
    padding: 20,
    paddingBottom: 44,
  },
  eyebrow: {
    color: '#3B5874',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.2,
    lineHeight: 16,
  },
  footer: {
    color: '#486581',
    fontSize: 14,
    lineHeight: 21,
  },
  heading: {
    gap: 7,
  },
  page: {
    backgroundColor: '#F4F7FA',
    flex: 1,
  },
  row: {
    borderTopColor: '#D9E2EC',
    borderTopWidth: 1,
    gap: 4,
    paddingTop: 12,
  },
  rowLabel: {
    color: '#486581',
    fontSize: 14,
    fontWeight: '800',
    lineHeight: 20,
  },
  rowValue: {
    color: '#102A43',
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 23,
  },
  safetyBody: {
    color: '#17324D',
    fontSize: 15,
    lineHeight: 22,
  },
  safetyNotice: {
    backgroundColor: '#E8F1F8',
    borderColor: '#9DB8CF',
    borderRadius: 16,
    borderWidth: 1,
    gap: 5,
    padding: 16,
  },
  safetyTitle: {
    color: '#102A43',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
  subtitle: {
    color: '#486581',
    fontSize: 16,
    lineHeight: 24,
  },
  title: {
    color: '#102A43',
    fontSize: 32,
    fontWeight: '900',
    letterSpacing: -0.4,
    lineHeight: 39,
  },
  warning: {
    backgroundColor: '#FFF0F1',
    borderColor: '#B42332',
    borderRadius: 16,
    borderWidth: 2,
    gap: 6,
    padding: 16,
  },
  warningBody: {
    color: '#6B101B',
    fontSize: 15,
    lineHeight: 22,
  },
  warningTitle: {
    color: '#6B101B',
    fontSize: 17,
    fontWeight: '900',
    lineHeight: 23,
  },
});
