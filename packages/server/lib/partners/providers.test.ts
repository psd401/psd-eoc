import { describe, expect, test } from 'bun:test';

import {
  AdminCreateUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminUserGlobalSignOutCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';

import {
  CognitoPartnerDirectory,
  PartnerProviderError,
  resolvePartnerProviders,
  SesPartnerMailer,
} from './providers';

const POOL = 'us-west-2_SyntheticPool';
const EMAIL = 'responder@agency.example.invalid';

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function recordingClient(answer: (command: unknown) => unknown) {
  const sent: unknown[] = [];
  return {
    sent,
    client: {
      send: (command: unknown) => {
        sent.push(command);
        try {
          return Promise.resolve(answer(command));
        } catch (error) {
          return Promise.reject(error);
        }
      },
    } as never,
  };
}

describe('the Cognito partner directory', () => {
  test('creates the account without Cognito’s own invitation and returns its subject', async () => {
    const recording = recordingClient(() => ({
      User: { Attributes: [{ Name: 'sub', Value: 'subject-1' }] },
    }));
    const directory = new CognitoPartnerDirectory(POOL, recording.client);
    expect(await directory.ensureEnabled(EMAIL)).toEqual({
      subject: 'subject-1',
    });
    const [create] = recording.sent as AdminCreateUserCommand[];
    expect(create).toBeInstanceOf(AdminCreateUserCommand);
    expect(create?.input).toMatchObject({
      UserPoolId: POOL,
      Username: EMAIL,
      MessageAction: 'SUPPRESS',
    });
  });

  test('re-enables an existing disabled account instead of failing', async () => {
    const recording = recordingClient((command) => {
      if (command instanceof AdminCreateUserCommand) {
        throw namedError('UsernameExistsException');
      }
      if (command instanceof AdminGetUserCommand) {
        return {
          Enabled: false,
          UserAttributes: [{ Name: 'sub', Value: 'subject-2' }],
        };
      }
      return {};
    });
    const directory = new CognitoPartnerDirectory(POOL, recording.client);
    expect(await directory.ensureEnabled(EMAIL)).toEqual({
      subject: 'subject-2',
    });
    expect(recording.sent.map((command) => command?.constructor)).toEqual([
      AdminCreateUserCommand,
      AdminGetUserCommand,
      AdminEnableUserCommand,
    ]);
  });

  test('signs the account out everywhere, then disables it; a missing account is fine', async () => {
    const recording = recordingClient(() => ({}));
    await new CognitoPartnerDirectory(POOL, recording.client).ensureDisabled(
      EMAIL,
    );
    expect(recording.sent.map((command) => command?.constructor)).toEqual([
      AdminUserGlobalSignOutCommand,
      AdminDisableUserCommand,
    ]);
    const missing = recordingClient(() => {
      throw namedError('UserNotFoundException');
    });
    await new CognitoPartnerDirectory(POOL, missing.client).ensureDisabled(
      EMAIL,
    );
  });

  test('a provider failure surfaces as a safe error with no address in it', async () => {
    const failing = recordingClient(() => {
      throw namedError('InternalErrorException');
    });
    let caught: unknown;
    try {
      await new CognitoPartnerDirectory(POOL, failing.client).ensureEnabled(
        EMAIL,
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PartnerProviderError);
    expect((caught as Error).message).not.toContain(EMAIL);
  });
});

describe('the SES partner mailer', () => {
  test('sends the branded account email from the configured sender', async () => {
    const recording = recordingClient(() => ({}));
    const mailer = new SesPartnerMailer(
      {
        fromEmailAddress: 'eoc@district.example.invalid',
        configurationSetName: 'synthetic-set',
        branding: {
          organizationName: 'Synthetic Example School District',
          applicationOrigin: 'https://eoc.example.invalid',
          senderDisplayName: 'Synthetic EOC',
        },
      },
      recording.client,
    );
    await mailer.send({
      to: EMAIL,
      subject: 'You have access',
      textBody: 'Hello.',
    });
    const [send] = recording.sent as SendEmailCommand[];
    expect(send).toBeInstanceOf(SendEmailCommand);
    expect(send?.input.FromEmailAddress).toBe(
      '"Synthetic EOC" <eoc@district.example.invalid>',
    );
    expect(send?.input.Destination?.ToAddresses).toEqual([EMAIL]);
    expect(send?.input.ConfigurationSetName).toBe('synthetic-set');
    expect(send?.input.Content?.Simple?.Body?.Text?.Data).toBe('Hello.');
    expect(send?.input.Content?.Simple?.Body?.Html?.Data).toContain(
      'Account notice from Synthetic Example School District',
    );
  });
});

describe('partner provider configuration', () => {
  const base = {
    PSD_EOC_ORGANIZATION_NAME: 'Synthetic Example School District',
    GOOGLE_OIDC_APPLICATION_ORIGIN: 'https://eoc.example.invalid',
    PSD_EOC_SES_FROM_ADDRESS: 'eoc@district.example.invalid',
  };

  test('is off when the pool is unconfigured or absent', () => {
    expect(resolvePartnerProviders(base)).toBeNull();
    expect(
      resolvePartnerProviders({
        ...base,
        PSD_EOC_PARTNER_USER_POOL_ID: 'UNCONFIGURED',
      }),
    ).toBeNull();
  });

  test('uses AWS for a real pool and synthetic stand-ins only for the synthetic id', () => {
    expect(
      resolvePartnerProviders({ ...base, PSD_EOC_PARTNER_USER_POOL_ID: POOL })
        ?.mode,
    ).toBe('aws');
    expect(
      resolvePartnerProviders({ PSD_EOC_PARTNER_USER_POOL_ID: 'SYNTHETIC' })
        ?.mode,
    ).toBe('synthetic');
  });

  test('stays off for a real pool with no SES sender', () => {
    expect(
      resolvePartnerProviders({
        ...base,
        PSD_EOC_SES_FROM_ADDRESS: undefined,
        PSD_EOC_PARTNER_USER_POOL_ID: POOL,
      }),
    ).toBeNull();
  });
});
