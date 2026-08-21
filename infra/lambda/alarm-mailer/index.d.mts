export function formatAlarmEmail(record: unknown): {
  body: string;
  subject: string;
};

export function mailAlarms(
  event: unknown,
  dependencies?: Readonly<{
    send?: (command: unknown) => Promise<unknown>;
    environment?: Readonly<Record<string, string | undefined>>;
  }>,
): Promise<{ sent: number }>;

export function handler(event: unknown): Promise<{ sent: number }>;
