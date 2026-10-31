/**
 * Process and simulator plumbing shared by the mobile end-to-end harnesses.
 *
 * Both the issue-32 synthetic journey and the native partner journey have to
 * choose a simulator, shell out to the platform tools, and tolerate the same
 * hosted-simulator flakes. Keeping that in one place means a fix to how a
 * device is chosen reaches both runners rather than one of them.
 */

export type MobileE2EPlatform = 'ios' | 'android';

export type CommandEnvironment = Record<string, string | undefined>;

export class CommandExitError extends Error {
  public constructor(
    public readonly exitCode: number,
    arguments_: readonly string[],
  ) {
    super(`${arguments_.join(' ')} exited with ${exitCode}.`);
  }
}

export interface CommandRunner {
  /** Runs a command, inheriting the console, and throws on a non-zero exit. */
  run(arguments_: readonly string[], cwd?: string): Promise<void>;
  /** Runs a command and returns its standard output. */
  output(arguments_: readonly string[]): Promise<string>;
  /** Runs a command whose failure is not an error. */
  bestEffort(arguments_: readonly string[]): Promise<void>;
}

export function createCommandRunner(
  defaultCwd: string,
  environment: CommandEnvironment,
): CommandRunner {
  return Object.freeze({
    async run(arguments_: readonly string[], cwd = defaultCwd): Promise<void> {
      const child = Bun.spawn([...arguments_], {
        cwd,
        env: environment,
        stdin: 'inherit',
        stdout: 'inherit',
        stderr: 'inherit',
      });
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new CommandExitError(exitCode, arguments_);
    },
    async output(arguments_: readonly string[]): Promise<string> {
      const child = Bun.spawn([...arguments_], {
        cwd: defaultCwd,
        env: environment,
        stdout: 'pipe',
        stderr: 'inherit',
      });
      const value = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      if (exitCode !== 0) throw new CommandExitError(exitCode, arguments_);
      return value;
    },
    async bestEffort(arguments_: readonly string[]): Promise<void> {
      const child = Bun.spawn([...arguments_], {
        cwd: defaultCwd,
        env: environment,
        stdout: 'ignore',
        stderr: 'ignore',
      });
      await child.exited;
    },
  });
}

/**
 * Chooses the iPhone simulator this run drives: the configured one, else a
 * booted one, else any available iPhone, booted here and waited for.
 */
export async function selectIosDevice(
  runner: CommandRunner,
  configured: string | undefined,
): Promise<string> {
  if (configured !== undefined && configured.length > 0) return configured;
  const listing = JSON.parse(
    await runner.output([
      'xcrun',
      'simctl',
      'list',
      'devices',
      'available',
      '--json',
    ]),
  ) as {
    devices?: Record<
      string,
      Array<{
        isAvailable?: boolean;
        name?: string;
        state?: string;
        udid?: string;
      }>
    >;
  };
  const devices = Object.values(listing.devices ?? {}).flat();
  const selected =
    devices.find(
      (device) =>
        device.isAvailable !== false &&
        device.state === 'Booted' &&
        device.name?.startsWith('iPhone') === true,
    ) ??
    devices.find(
      (device) =>
        device.isAvailable !== false &&
        device.name?.startsWith('iPhone') === true,
    );
  if (selected?.udid === undefined) {
    throw new Error('No available iPhone simulator was found.');
  }
  if (selected.state !== 'Booted') {
    await runner.run(['xcrun', 'simctl', 'boot', selected.udid]);
  }
  await runner.run(['xcrun', 'simctl', 'bootstatus', selected.udid, '-b']);
  return selected.udid;
}

/**
 * Chooses the Android emulator this run drives, and resolves it to the AVD
 * name Expo needs so the build, ADB, and Maestro all use one emulator.
 */
export async function selectAndroidDevice(
  runner: CommandRunner,
  configured: string | undefined,
): Promise<Readonly<{ expoName: string; serial: string }>> {
  const serial =
    configured !== undefined && configured.length > 0
      ? configured
      : (await runner.output(['adb', 'devices']))
          .split('\n')
          .map((line) => line.trim())
          .find((line) => /^emulator-[0-9]+\tdevice$/u.test(line))
          ?.split('\t')[0];
  if (serial === undefined) throw new Error('No Android emulator was found.');
  if (!/^emulator-[0-9]+$/u.test(serial)) {
    throw new Error(
      `ANDROID_SERIAL must select a running Android emulator; received ${serial}.`,
    );
  }
  const expoName = (
    await runner.output(['adb', '-s', serial, 'emu', 'avd', 'name'])
  )
    .trim()
    .split(/\r?\n/u)[0];
  if (expoName === undefined || expoName.length === 0 || expoName === 'OK') {
    throw new Error(`Could not resolve the AVD name for ${serial}.`);
  }
  return Object.freeze({ expoName, serial });
}

/** Saves a screenshot of the device under test. */
export async function captureScreen(
  runner: CommandRunner,
  platform: MobileE2EPlatform,
  deviceId: string,
  destination: string,
): Promise<void> {
  if (platform === 'ios') {
    await runner.run([
      'xcrun',
      'simctl',
      'io',
      deviceId,
      'screenshot',
      destination,
    ]);
    return;
  }
  const screenshot = Bun.spawn(
    ['adb', '-s', deviceId, 'exec-out', 'screencap', '-p'],
    { stdout: 'pipe', stderr: 'inherit' },
  );
  const bytes = await new Response(screenshot.stdout).arrayBuffer();
  if ((await screenshot.exited) !== 0) {
    throw new Error('Android screenshot capture failed.');
  }
  await Bun.write(destination, bytes);
}

/** A high user port, so parallel runs on one machine do not collide. */
export function ephemeralPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

/** Waits for an HTTP endpoint to answer, or gives up. */
export async function waitForHttp(
  url: string,
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      // Any answer proves the listener is up; a redirect or a 404 is one.
      if (response.status > 0) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`${url} did not answer within ${attempts} seconds.`);
}
