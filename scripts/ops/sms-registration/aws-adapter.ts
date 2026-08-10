import {
  CreateRegistrationAssociationCommand,
  CreateRegistrationAttachmentCommand,
  CreateRegistrationCommand,
  DescribePhoneNumbersCommand,
  DescribeRegistrationAttachmentsCommand,
  DescribeRegistrationFieldDefinitionsCommand,
  DescribeRegistrationFieldValuesCommand,
  DescribeRegistrationVersionsCommand,
  DescribeRegistrationsCommand,
  ListRegistrationAssociationsCommand,
  PinpointSMSVoiceV2Client,
  PutRegistrationFieldValueCommand,
  RequestPhoneNumberCommand,
  SubmitRegistrationVersionCommand,
} from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

import {
  TARGET_REGION,
  toRegistrationFieldFeedback,
  type FieldDefinition,
  type PhoneNumberRecord,
  type RegistrationAssociationRecord,
  type RegistrationAttachmentRecord,
  type RegistrationFieldFeedback,
  type RegistrationRecord,
  type RegistrationVersionRecord,
  type SmsRegistrationApi,
} from './core';

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`AWS response omitted ${label}.`);
  }
  return value;
}

function requiredPositiveInteger(
  value: number | undefined,
  label: string,
): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    throw new Error(`AWS response omitted a positive ${label}.`);
  }
  return value;
}

export function createAwsApi(): SmsRegistrationApi {
  const sms = new PinpointSMSVoiceV2Client({ region: TARGET_REGION });
  const sts = new STSClient({ region: TARGET_REGION });

  return {
    async associateRegistration(input): Promise<void> {
      await sms.send(
        new CreateRegistrationAssociationCommand({
          RegistrationId: input.registrationId,
          ResourceId: input.resourceId,
        }),
      );
    },

    async createAttachment(input) {
      const output = await sms.send(
        new CreateRegistrationAttachmentCommand({
          AttachmentBody: input.attachmentBody,
          ClientToken: input.clientToken,
          Tags: [{ Key: 'Name', Value: input.name }],
        }),
      );
      return {
        attachmentId: required(
          output.RegistrationAttachmentId,
          'RegistrationAttachmentId',
        ),
        attachmentStatus: required(output.AttachmentStatus, 'AttachmentStatus'),
      };
    },

    async createRegistration(input) {
      const output = await sms.send(
        new CreateRegistrationCommand({
          ClientToken: input.clientToken,
          RegistrationType: input.registrationType,
          Tags: [{ Key: 'Name', Value: input.name }],
        }),
      );
      return {
        registrationId: required(output.RegistrationId, 'RegistrationId'),
      };
    },

    async describeFieldDefinitions(registrationType) {
      const definitions: FieldDefinition[] = [];
      let nextToken: string | undefined;
      do {
        const output = await sms.send(
          new DescribeRegistrationFieldDefinitionsCommand({
            MaxResults: 100,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            RegistrationType: registrationType,
          }),
        );
        for (const definition of output.RegistrationFieldDefinitions ?? []) {
          definitions.push({
            fieldPath: required(definition.FieldPath, 'FieldPath'),
            fieldRequirement: required(
              definition.FieldRequirement,
              'FieldRequirement',
            ),
            fieldType: required(definition.FieldType, 'FieldType'),
            ...(definition.SelectValidation === undefined
              ? {}
              : {
                  selectValidation: {
                    ...(definition.SelectValidation.MaxChoices === undefined
                      ? {}
                      : {
                          maxChoices: definition.SelectValidation.MaxChoices,
                        }),
                    ...(definition.SelectValidation.MinChoices === undefined
                      ? {}
                      : {
                          minChoices: definition.SelectValidation.MinChoices,
                        }),
                    ...(definition.SelectValidation.Options === undefined
                      ? {}
                      : { options: definition.SelectValidation.Options }),
                  },
                }),
            ...(definition.TextValidation === undefined
              ? {}
              : {
                  textValidation: {
                    ...(definition.TextValidation.MaxLength === undefined
                      ? {}
                      : { maxLength: definition.TextValidation.MaxLength }),
                    ...(definition.TextValidation.MinLength === undefined
                      ? {}
                      : { minLength: definition.TextValidation.MinLength }),
                    ...(definition.TextValidation.Pattern === undefined
                      ? {}
                      : { pattern: definition.TextValidation.Pattern }),
                  },
                }),
            ...(definition.DisplayHints?.Title === undefined
              ? {}
              : { title: definition.DisplayHints.Title }),
          });
        }
        nextToken = output.NextToken;
      } while (nextToken !== undefined);
      return definitions;
    },

    async describeAttachments(attachmentIds) {
      const attachments: RegistrationAttachmentRecord[] = [];
      for (let offset = 0; offset < attachmentIds.length; offset += 5) {
        let nextToken: string | undefined;
        do {
          const output = await sms.send(
            new DescribeRegistrationAttachmentsCommand({
              MaxResults: 5,
              ...(nextToken === undefined ? {} : { NextToken: nextToken }),
              RegistrationAttachmentIds: attachmentIds.slice(
                offset,
                offset + 5,
              ),
            }),
          );
          for (const attachment of output.RegistrationAttachments ?? []) {
            attachments.push({
              attachmentId: required(
                attachment.RegistrationAttachmentId,
                'RegistrationAttachmentId',
              ),
              status: required(attachment.AttachmentStatus, 'AttachmentStatus'),
            });
          }
          nextToken = output.NextToken;
        } while (nextToken !== undefined);
      }
      return attachments;
    },

    async describePhoneNumbers(phoneNumberIds) {
      const output = await sms.send(
        new DescribePhoneNumbersCommand({
          PhoneNumberIds: [...phoneNumberIds],
        }),
      );
      return (output.PhoneNumbers ?? []).map(
        (phone): PhoneNumberRecord => ({
          phoneNumberId: required(phone.PhoneNumberId, 'PhoneNumberId'),
          ...(phone.RegistrationId === undefined
            ? {}
            : { registrationId: phone.RegistrationId }),
          numberType: required(phone.NumberType, 'phone number NumberType'),
          status: required(phone.Status, 'phone number Status'),
        }),
      );
    },

    async describeRegistrationFieldFeedback(input) {
      const fields: RegistrationFieldFeedback[] = [];
      let nextToken: string | undefined;
      do {
        const output = await sms.send(
          new DescribeRegistrationFieldValuesCommand({
            MaxResults: 100,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            RegistrationId: input.registrationId,
            ...(input.versionNumber === undefined
              ? {}
              : { VersionNumber: input.versionNumber }),
          }),
        );
        for (const field of output.RegistrationFieldValues ?? []) {
          const feedback = toRegistrationFieldFeedback(
            field.FieldPath,
            field.DeniedReason,
            field.Feedback,
          );
          if (feedback !== undefined) fields.push(feedback);
        }
        nextToken = output.NextToken;
      } while (nextToken !== undefined);
      return fields;
    },

    async describeRegistrationVersions(registrationId) {
      const versions: RegistrationVersionRecord[] = [];
      let nextToken: string | undefined;
      do {
        const output = await sms.send(
          new DescribeRegistrationVersionsCommand({
            MaxResults: 100,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            RegistrationId: registrationId,
          }),
        );
        for (const version of output.RegistrationVersions ?? []) {
          versions.push({
            deniedReasons: (version.DeniedReasons ?? []).map((reason) => {
              const code = required(reason.Reason, 'denied Reason');
              const description = required(
                reason.ShortDescription,
                'denied ShortDescription',
              );
              return `${code}: ${description}`;
            }),
            status: required(
              version.RegistrationVersionStatus,
              'RegistrationVersionStatus',
            ),
            ...(version.Feedback === undefined
              ? {}
              : { feedback: version.Feedback }),
            versionNumber: requiredPositiveInteger(
              version.VersionNumber,
              'VersionNumber',
            ),
          });
        }
        nextToken = output.NextToken;
      } while (nextToken !== undefined);
      return versions;
    },

    async describeRegistrations(registrationIds) {
      const output = await sms.send(
        new DescribeRegistrationsCommand({
          RegistrationIds: [...registrationIds],
        }),
      );
      return (output.Registrations ?? []).map(
        (registration): RegistrationRecord => ({
          registrationId: required(
            registration.RegistrationId,
            'RegistrationId',
          ),
          registrationStatus: required(
            registration.RegistrationStatus,
            'RegistrationStatus',
          ),
          registrationType: required(
            registration.RegistrationType,
            'RegistrationType',
          ),
          ...(registration.CurrentVersionNumber === undefined
            ? {}
            : { currentVersionNumber: registration.CurrentVersionNumber }),
        }),
      );
    },

    async getCallerIdentity() {
      const output = await sts.send(new GetCallerIdentityCommand({}));
      return {
        ...(output.Account === undefined ? {} : { accountId: output.Account }),
        ...(output.Arn === undefined ? {} : { arn: output.Arn }),
      };
    },

    async putFieldValue(input): Promise<void> {
      await sms.send(
        new PutRegistrationFieldValueCommand({
          FieldPath: input.fieldPath,
          RegistrationId: input.registrationId,
          ...(input.attachmentId === undefined
            ? {}
            : { RegistrationAttachmentId: input.attachmentId }),
          ...(input.select === undefined
            ? {}
            : { SelectChoices: [...input.select] }),
          ...(input.text === undefined ? {} : { TextValue: input.text }),
        }),
      );
    },

    async listRegistrationAssociations(registrationId) {
      const associations: RegistrationAssociationRecord[] = [];
      let nextToken: string | undefined;
      do {
        const output = await sms.send(
          new ListRegistrationAssociationsCommand({
            MaxResults: 100,
            ...(nextToken === undefined ? {} : { NextToken: nextToken }),
            RegistrationId: registrationId,
          }),
        );
        for (const association of output.RegistrationAssociations ?? []) {
          associations.push({
            resourceId: required(association.ResourceId, 'ResourceId'),
            resourceType: required(association.ResourceType, 'ResourceType'),
          });
        }
        nextToken = output.NextToken;
      } while (nextToken !== undefined);
      return associations;
    },

    async requestTollFreeNumber(input) {
      const output = await sms.send(
        new RequestPhoneNumberCommand({
          ClientToken: input.clientToken,
          DeletionProtectionEnabled: true,
          InternationalSendingEnabled: false,
          IsoCountryCode: 'US',
          MessageType: 'TRANSACTIONAL',
          NumberCapabilities: ['SMS'],
          NumberType: 'TOLL_FREE',
          OptOutListName: input.optOutListName,
          RegistrationId: input.registrationId,
          Tags: [{ Key: 'Name', Value: input.name }],
        }),
      );
      return {
        ...(output.MonthlyLeasingPrice === undefined
          ? {}
          : { monthlyLeasingPrice: output.MonthlyLeasingPrice }),
        phoneNumberId: required(output.PhoneNumberId, 'PhoneNumberId'),
        ...(output.RegistrationId === undefined
          ? {}
          : { registrationId: output.RegistrationId }),
        status: required(output.Status, 'phone number Status'),
      };
    },

    async submitRegistration(registrationId) {
      const output = await sms.send(
        new SubmitRegistrationVersionCommand({
          RegistrationId: registrationId,
        }),
      );
      return {
        versionStatus: required(
          output.RegistrationVersionStatus,
          'RegistrationVersionStatus',
        ),
      };
    },
  };
}
