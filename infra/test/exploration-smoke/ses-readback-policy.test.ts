import { describe, expect, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflowUrl = new URL(
  '../../../.github/workflows/deploy-exploration-smoke-ses-readback-policy.yml',
  import.meta.url,
);
const templateUrl = new URL(
  '../../exploration-smoke-ses-readback-policy.template.json',
  import.meta.url,
);

const accountId = '<aws-account-id>';
const region = 'us-west-2';
const roleName = 'psd-eoc-exploration-smoke-github-deploy';
const roleArn = `arn:aws:iam::${accountId}:role/${roleName}`;
const appRunnerServiceArn = `arn:aws:apprunner:${region}:${accountId}:service/psd-eoc-exploration-smoke/fd60545104344bd39ae9920feef7dd5c`;
const configurationSetArn = `arn:aws:ses:${region}:${accountId}:configuration-set/psd-eoc-transactional`;
const policyName = 'psd-eoc-exploration-smoke-ses-readback';

interface PolicyTemplate {
  readonly AWSTemplateFormatVersion: string;
  readonly Description: string;
  readonly Resources: Readonly<Record<string, unknown>>;
}

interface ScenarioResult {
  readonly awsCalls: readonly string[];
  readonly changeSetRequest: unknown;
  readonly exitCode: number;
  readonly result: unknown;
  readonly stderr: string;
}

async function readWorkflow(): Promise<string> {
  return Bun.file(workflowUrl).text();
}

async function readTemplate(): Promise<PolicyTemplate> {
  return Bun.file(templateUrl).json();
}

function authorizedPredecessor(template: PolicyTemplate): PolicyTemplate {
  const predecessor = structuredClone(template) as PolicyTemplate & {
    Description: string;
    Resources: {
      ExplorationSmokeSesReadbackPolicy: {
        Properties: { PolicyDocument: { Statement: unknown[] } };
      };
    };
  };
  predecessor.Description =
    'Retained least-privilege SES readback policy for the protected PSD EOC exploration deployment role';
  predecessor.Resources.ExplorationSmokeSesReadbackPolicy.Properties.PolicyDocument.Statement =
    predecessor.Resources.ExplorationSmokeSesReadbackPolicy.Properties.PolicyDocument.Statement.slice(
      0,
      1,
    );
  return predecessor;
}

function applyScript(workflow: string): string {
  const script = workflow.match(
    / {6}- name: Apply exact retained policy and prove boundaries[\s\S]*? {8}run: \|\n([\s\S]*?)\n {6}- name: Upload exact policy and readback evidence/,
  )?.[1];
  if (script === undefined) {
    throw new Error('protected SES readback policy apply step is missing');
  }
  return script.replace(/^ {10}/gm, '');
}

async function runScenario(options: {
  readonly changeSetMismatch?: boolean;
  readonly eventTypeMismatch?: 'missing' | 'superset';
  readonly existingPredecessor?: boolean;
  readonly existingStack: boolean;
  readonly interruptedCreate?: boolean;
  readonly templateMismatch?: boolean;
}): Promise<ScenarioResult> {
  const directory = await mkdtemp(join(tmpdir(), 'psd-eoc-ses-policy-'));
  try {
    const fakeBin = join(directory, 'bin');
    const artifacts = join(directory, 'artifacts');
    const readback = join(artifacts, 'readback');
    const marker = join(directory, 'policy-applied');
    const updatedMarker = join(directory, 'policy-updated');
    const predecessorTemplate = join(directory, 'policy-predecessor.json');
    const calls = join(directory, 'aws-calls.txt');
    const capturedRequest = join(directory, 'change-set-request.json');
    const summary = join(directory, 'summary.md');
    await Promise.all([
      mkdir(fakeBin, { recursive: true }),
      mkdir(readback, { recursive: true }),
    ]);
    await Bun.write(
      join(artifacts, 'exploration-smoke-ses-readback-policy.template.json'),
      JSON.stringify(await readTemplate(), null, 2),
    );
    await Bun.write(
      predecessorTemplate,
      JSON.stringify(authorizedPredecessor(await readTemplate()), null, 2),
    );
    if (options.existingStack) {
      await Bun.write(marker, 'existing\n');
    }

    const awsPath = join(fakeBin, 'aws');
    await Bun.write(
      awsPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s:%s:%s\n' "$1" "$2" "\${AWS_ACCESS_KEY_ID:-missing}" >> "$AWS_CALLS"

arg_value() {
  local wanted=$1
  shift
  while [[ $# -gt 0 ]]; do
    if [[ "$1" == "$wanted" ]]; then
      printf '%s\n' "$2"
      return 0
    fi
    shift
  done
  return 1
}

role_json() {
  printf '%s\n' '{
    "Arn":"arn:aws:iam::<aws-account-id>:role/psd-eoc-exploration-smoke-github-deploy",
    "RoleId":"AROATESTROLE",
    "RoleName":"psd-eoc-exploration-smoke-github-deploy",
    "CreateDate":"2026-08-15T00:00:00Z",
    "AssumeRolePolicyDocument":{"Statement":[{
      "Action":"sts:AssumeRoleWithWebIdentity",
      "Condition":{"StringEquals":{
        "token.actions.githubusercontent.com:aud":"sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub":"repo:psd401@1902994/psd-eoc@1326178900:environment:exploration-smoke"
      }},
      "Effect":"Allow",
      "Principal":{"Federated":"arn:aws:iam::<aws-account-id>:oidc-provider/token.actions.githubusercontent.com"}
    }]},
    "MaxSessionDuration":3600,
    "PermissionsBoundary":null
  }'
}

template_response() {
  local source=$POLICY_TEMPLATE
  if [[ "$AUTHORIZED_PREDECESSOR" == "true" && ! -e "$POLICY_UPDATED_MARKER" ]]; then
    source=$PREDECESSOR_TEMPLATE
  fi
  if [[ "$TEMPLATE_MISMATCH" == "true" && ! -e "$POLICY_UPDATED_MARKER" ]]; then
    jq -n --slurpfile template "$source" '{TemplateBody:($template[0] | .Description = "unapproved retained policy")}'
  else
    jq -n --slurpfile template "$source" '{TemplateBody:$template[0]}'
  fi
}

retained_policy_json() {
  local source=$POLICY_TEMPLATE
  if [[ "$AUTHORIZED_PREDECESSOR" == "true" && ! -e "$POLICY_UPDATED_MARKER" ]]; then
    source=$PREDECESSOR_TEMPLATE
  fi
  jq -n \
    --arg policy_name "$POLICY_NAME" \
    --arg role_name "$DEPLOY_ROLE_NAME" \
    --slurpfile template "$source" \
    '{
      RoleName:$role_name,
      PolicyName:$policy_name,
      PolicyDocument:$template[0].Resources.ExplorationSmokeSesReadbackPolicy.Properties.PolicyDocument
    }'
}

case "$1:$2" in
  sts:get-caller-identity)
    if [[ "\${AWS_ACCESS_KEY_ID:-}" == "deploy-access" ]]; then
      if printf '%s\n' "$@" | grep -q Account; then
        printf '%s\n' '<aws-account-id>'
      else
        printf '%s\n' 'arn:aws:sts::<aws-account-id>:assumed-role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2/psd-eoc-ses-policy-1'
      fi
    elif printf '%s\n' "$@" | grep -q Account; then
      printf '%s\n' '<aws-account-id>'
    else
      printf '%s\n' 'arn:aws:sts::<aws-account-id>:assumed-role/psd-eoc-exploration-smoke-github-deploy/test-oidc'
    fi
    ;;
  sts:assume-role)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    test "$(arg_value --role-arn "$@")" = "$CDK_DEPLOY_ROLE_ARN"
    printf '%s\n' '{"AccessKeyId":"deploy-access","SecretAccessKey":"deploy-secret","SessionToken":"deploy-token"}'
    ;;
  iam:list-account-aliases)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    printf '%s\n' '{"AccountAliases":["psd401"]}'
    ;;
  iam:get-role)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    role_json
    ;;
  iam:list-role-policies)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    if [[ -e "$POLICY_MARKER" ]]; then
      printf '%s\n' '{"PolicyNames":["psd-eoc-exploration-smoke-github-deploy","psd-eoc-exploration-smoke-ses-readback"]}'
    else
      printf '%s\n' '{"PolicyNames":["psd-eoc-exploration-smoke-github-deploy"]}'
    fi
    ;;
  iam:get-role-policy)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    requested=$(arg_value --policy-name "$@")
    if [[ "$requested" == "psd-eoc-exploration-smoke-ses-readback" ]]; then
      retained_policy_json
    else
      printf '%s\n' '{
        "RoleName":"psd-eoc-exploration-smoke-github-deploy",
        "PolicyName":"psd-eoc-exploration-smoke-github-deploy",
        "PolicyDocument":{"Version":"2012-10-17","Statement":[{
          "Sid":"ExistingAuthority",
          "Effect":"Allow",
          "Action":"sts:AssumeRole",
          "Resource":"arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-deploy-role-<aws-account-id>-us-west-2"
        }]}
      }'
    fi
    ;;
  iam:list-attached-role-policies)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    printf '%s\n' '{"AttachedPolicies":[]}'
    ;;
  iam:simulate-principal-policy)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    resource=$(arg_value --resource-arns "$@")
    actions=()
    collect=false
    for argument in "$@"; do
      if [[ "$argument" == "--action-names" ]]; then
        collect=true
        continue
      fi
      if [[ "$argument" == "--resource-arns" ]]; then
        collect=false
      elif [[ "$collect" == true ]]; then
        actions+=("$argument")
      fi
    done
    jq -n \
      --arg resource "$resource" \
      --arg app_runner_canonical "$APP_RUNNER_SERVICE_ARN" \
      --arg configuration_set_canonical "$CONFIGURATION_SET_ARN" \
      --args '{EvaluationResults:[$ARGS.positional[] | {
        EvalActionName:.,
        EvalDecision:(if
          ($resource == $configuration_set_canonical and (. == "ses:GetConfigurationSet" or . == "ses:GetConfigurationSetEventDestinations")) or
          ($resource == $app_runner_canonical and (. == "apprunner:AssociateCustomDomain" or . == "apprunner:DescribeCustomDomains" or . == "apprunner:ListOperations"))
          then "allowed" else "implicitDeny" end),
        EvalResourceName:$resource
      }]}' "\${actions[@]}"
    ;;
  cloudformation:describe-stacks)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    if [[ ! -e "$POLICY_MARKER" ]]; then
      if [[ "$INTERRUPTED_CREATE" == "true" ]]; then
        printf '%s\n' '{"Stacks":[{
          "RoleARN":"arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-cfn-exec-role-<aws-account-id>-us-west-2",
          "StackStatus":"REVIEW_IN_PROGRESS"
        }]}'
      else
        printf '%s\n' 'An error occurred (ValidationError): Stack does not exist' >&2
        exit 254
      fi
    else
      printf '%s\n' '{"Stacks":[{
        "RoleARN":"arn:aws:iam::<aws-account-id>:role/cdk-hnb659fds-cfn-exec-role-<aws-account-id>-us-west-2",
        "StackStatus":"CREATE_COMPLETE"
      }]}'
    fi
    ;;
  cloudformation:get-template)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    [[ -e "$POLICY_MARKER" || "$INTERRUPTED_CREATE" == "true" ]]
    template_response
    ;;
  cloudformation:list-change-sets)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    test "$INTERRUPTED_CREATE" = "true"
    test ! -e "$POLICY_MARKER"
    printf '%s\n' '{"Summaries":[{
      "ChangeSetId":"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-99-2/99999999-9999-9999-9999-999999999999",
      "ChangeSetName":"psd-eoc-ses-readback-99-2",
      "ExecutionStatus":"AVAILABLE",
      "StackName":"PsdEocExplorationSmokeSesReadbackPolicy",
      "Status":"CREATE_COMPLETE"
    }]}'
    ;;
  cloudformation:create-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    request=$(arg_value --cli-input-json "$@")
    cp "\${request#file://}" "$CAPTURED_CHANGE_SET_REQUEST"
    printf '%s\n' '{
      "Id":"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-1-1/00000000-0000-0000-0000-000000000000",
      "StackId":"arn:aws:cloudformation:us-west-2:<aws-account-id>:stack/PsdEocExplorationSmokeSesReadbackPolicy/11111111-1111-1111-1111-111111111111"
    }'
    ;;
  cloudformation:wait)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    if [[ "$3" == "change-set-create-complete" && "$EXISTING_STACK" == "true" && "$AUTHORIZED_PREDECESSOR" == "false" ]]; then
      exit 255
    fi
    ;;
  cloudformation:describe-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    if [[ "$INTERRUPTED_CREATE" == "true" && ! -e "$POLICY_MARKER" ]]; then
      action=Add
      if [[ "$CHANGE_SET_MISMATCH" == "true" ]]; then action=Modify; fi
      jq -n --arg action "$action" '{
        ChangeSetId:"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-99-2/99999999-9999-9999-9999-999999999999",
        ChangeSetName:"psd-eoc-ses-readback-99-2",
        OnStackFailure:"ROLLBACK",
        Description:"Exact SES readback policy for GitHub run 99/2 with client token psd-eoc-ses-readback-99-2",
        StackName:"PsdEocExplorationSmokeSesReadbackPolicy",
        Status:"CREATE_COMPLETE",
        ExecutionStatus:"AVAILABLE",
        Capabilities:["CAPABILITY_NAMED_IAM"],
        Changes:[{ResourceChange:{Action:$action,LogicalResourceId:"ExplorationSmokeSesReadbackPolicy",ResourceType:"AWS::IAM::Policy"}}]
      }'
    elif [[ "$EXISTING_STACK" == "true" && "$AUTHORIZED_PREDECESSOR" == "true" ]]; then
      action=Modify
      if [[ "$CHANGE_SET_MISMATCH" == "true" ]]; then action=Add; fi
      jq -n --arg action "$action" '{
        ChangeSetId:"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-1-1/00000000-0000-0000-0000-000000000000",
        ChangeSetName:"psd-eoc-ses-readback-1-1",
        OnStackFailure:null,
        Description:"Exact SES readback policy for GitHub run 1/1 with client token psd-eoc-ses-readback-1-1",
        StackName:"PsdEocExplorationSmokeSesReadbackPolicy",
        Status:"CREATE_COMPLETE",
        ExecutionStatus:"AVAILABLE",
        Capabilities:["CAPABILITY_NAMED_IAM"],
        Changes:[{ResourceChange:{Action:$action,LogicalResourceId:"ExplorationSmokeSesReadbackPolicy",Replacement:"False",ResourceType:"AWS::IAM::Policy"}}]
      }'
    elif [[ "$EXISTING_STACK" == "true" ]]; then
      printf '%s\n' '{
        "ChangeSetId":"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-1-1/00000000-0000-0000-0000-000000000000",
        "ChangeSetName":"psd-eoc-ses-readback-1-1",
        "StackName":"PsdEocExplorationSmokeSesReadbackPolicy",
        "Status":"FAILED",
        "ExecutionStatus":"UNAVAILABLE",
        "StatusReason":"No updates are to be performed.",
        "Changes":[]
      }'
    else
      action=Add
      if [[ "$CHANGE_SET_MISMATCH" == "true" ]]; then action=Modify; fi
      jq -n --arg action "$action" '{
        ChangeSetId:"arn:aws:cloudformation:us-west-2:<aws-account-id>:changeSet/psd-eoc-ses-readback-1-1/00000000-0000-0000-0000-000000000000",
        ChangeSetName:"psd-eoc-ses-readback-1-1",
        OnStackFailure:"ROLLBACK",
        Description:"Exact SES readback policy for GitHub run 1/1 with client token psd-eoc-ses-readback-1-1",
        StackName:"PsdEocExplorationSmokeSesReadbackPolicy",
        Status:"CREATE_COMPLETE",
        ExecutionStatus:"AVAILABLE",
        Capabilities:["CAPABILITY_NAMED_IAM"],
        Changes:[{ResourceChange:{Action:$action,LogicalResourceId:"ExplorationSmokeSesReadbackPolicy",ResourceType:"AWS::IAM::Policy"}}]
      }'
    fi
    ;;
  cloudformation:execute-change-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "deploy-access"
    touch "$POLICY_MARKER"
    touch "$POLICY_UPDATED_MARKER"
    ;;
  sesv2:get-configuration-set)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    printf '%s\n' '{"ConfigurationSetName":"psd-eoc-transactional","SendingOptions":{"SendingEnabled":false}}'
    ;;
  sesv2:get-configuration-set-event-destinations)
    test "\${AWS_ACCESS_KEY_ID:-}" = "oidc-access"
    event_types='["SEND","RENDERING_FAILURE","REJECT","DELIVERY_DELAY","DELIVERY","COMPLAINT","BOUNCE"]'
    if [[ "$EVENT_TYPE_MISMATCH" == "missing" ]]; then
      event_types='["BOUNCE","COMPLAINT","DELIVERY","REJECT","RENDERING_FAILURE","SEND"]'
    elif [[ "$EVENT_TYPE_MISMATCH" == "superset" ]]; then
      event_types='["BOUNCE","COMPLAINT","DELIVERY","DELIVERY_DELAY","OPEN","REJECT","RENDERING_FAILURE","SEND"]'
    fi
    printf '%s\n' '{"EventDestinations":[{
      "Name":"psd-eoc-email-events",
      "Enabled":true,
      "MatchingEventTypes":'"$event_types"',
      "SnsDestination":{"TopicArn":"arn:aws:sns:us-west-2:<aws-account-id>:psd-eoc-email-events"}
    }]}'
    ;;
  *)
    printf 'Unexpected AWS call: %s %s\n' "$1" "$2" >&2
    exit 90
    ;;
esac
`,
    );
    await chmod(awsPath, 0o755);

    const child = Bun.spawnSync({
      cmd: ['bash', '-c', applyScript(await readWorkflow())],
      cwd: directory,
      env: {
        ...process.env,
        AWS_ACCESS_KEY_ID: 'oidc-access',
        APP_RUNNER_SERVICE_ARN: appRunnerServiceArn,
        AWS_ACCOUNT_ALIAS: 'psd401',
        AWS_ACCOUNT_ID: accountId,
        AWS_CALLS: calls,
        AWS_REGION: region,
        AWS_SECRET_ACCESS_KEY: 'oidc-secret',
        AWS_SESSION_TOKEN: 'oidc-token',
        AUTHORIZED_PREDECESSOR: options.existingPredecessor ? 'true' : 'false',
        CAPTURED_CHANGE_SET_REQUEST: capturedRequest,
        CDK_CFN_EXEC_ROLE_ARN: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-cfn-exec-role-${accountId}-${region}`,
        CDK_DEPLOY_ROLE_ARN: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-deploy-role-${accountId}-${region}`,
        CHANGE_SET_MISMATCH: options.changeSetMismatch ? 'true' : 'false',
        CONFIGURATION_SET_ARN: configurationSetArn,
        CONFIGURATION_SET_NAME: 'psd-eoc-transactional',
        DEPLOY_ROLE_ARN: roleArn,
        DEPLOY_ROLE_NAME: roleName,
        EVENT_DESTINATION_NAME: 'psd-eoc-email-events',
        EVENT_TOPIC_ARN: `arn:aws:sns:${region}:${accountId}:psd-eoc-email-events`,
        EVENT_TYPE_MISMATCH: options.eventTypeMismatch ?? 'none',
        EXISTING_STACK: options.existingStack ? 'true' : 'false',
        GITHUB_OIDC_PROVIDER_ARN: `arn:aws:iam::${accountId}:oidc-provider/token.actions.githubusercontent.com`,
        GITHUB_OIDC_SUBJECT:
          'repo:psd401@1902994/psd-eoc@1326178900:environment:exploration-smoke',
        GITHUB_RUN_ATTEMPT: '1',
        GITHUB_RUN_ID: '1',
        GITHUB_STEP_SUMMARY: summary,
        INTERRUPTED_CREATE: options.interruptedCreate ? 'true' : 'false',
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
        POLICY_MARKER: marker,
        POLICY_NAME: policyName,
        POLICY_UPDATED_MARKER: updatedMarker,
        POLICY_TEMPLATE: join(
          artifacts,
          'exploration-smoke-ses-readback-policy.template.json',
        ),
        PREDECESSOR_TEMPLATE: predecessorTemplate,
        RUNNER_TEMP: directory,
        SOURCE_SHA: '0'.repeat(40),
        STACK_NAME: 'PsdEocExplorationSmokeSesReadbackPolicy',
        TEMPLATE_MISMATCH: options.templateMismatch ? 'true' : 'false',
      },
      stderr: 'pipe',
      stdout: 'pipe',
    });

    const resultPath = join(readback, 'policy-apply-result.json');
    return {
      awsCalls: (await Bun.file(calls).exists())
        ? (await Bun.file(calls).text()).trim().split('\n')
        : [],
      changeSetRequest: (await Bun.file(capturedRequest).exists())
        ? await Bun.file(capturedRequest).json()
        : undefined,
      exitCode: child.exitCode,
      result: (await Bun.file(resultPath).exists())
        ? await Bun.file(resultPath).json()
        : undefined,
      stderr: child.stderr.toString(),
    };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

describe('protected exploration SES readback policy', () => {
  it('contains only the exact SES reads and App Runner domain authority on canonical resources', async () => {
    expect(await readTemplate()).toEqual({
      AWSTemplateFormatVersion: '2010-09-09',
      Description:
        'Retained least-privilege operations policy for the protected PSD EOC exploration deployment role',
      Resources: {
        ExplorationSmokeSesReadbackPolicy: {
          DeletionPolicy: 'Retain',
          Properties: {
            PolicyDocument: {
              Statement: [
                {
                  Action: [
                    'ses:GetConfigurationSet',
                    'ses:GetConfigurationSetEventDestinations',
                  ],
                  Effect: 'Allow',
                  Resource: configurationSetArn,
                  Sid: 'ReadCanonicalConfigurationSetOnly',
                },
                {
                  Action: [
                    'apprunner:AssociateCustomDomain',
                    'apprunner:DescribeCustomDomains',
                    'apprunner:ListOperations',
                  ],
                  Effect: 'Allow',
                  Resource: appRunnerServiceArn,
                  Sid: 'ReadAndAssociateCanonicalCustomDomainOnly',
                },
              ],
              Version: '2012-10-17',
            },
            PolicyName: policyName,
            Roles: [roleName],
          },
          Type: 'AWS::IAM::Policy',
          UpdateReplacePolicy: 'Retain',
        },
      },
    });
  });

  it('excludes wildcard, disassociation, Route53, send, and unrelated App Runner authority', async () => {
    const serialized = JSON.stringify(await readTemplate());
    expect(serialized).not.toContain('"Resource":"*"');
    expect(serialized).not.toContain('apprunner:DisassociateCustomDomain');
    expect(serialized).not.toContain('route53:');
    expect(serialized).not.toContain('ses:Send');
    expect(serialized).not.toContain('apprunner:DeleteService');
    expect(serialized).not.toContain('apprunner:UpdateService');
  });

  it('uses a protected main-only OIDC workflow with immutable source and zero provider writes', async () => {
    const workflow = await readWorkflow();
    expect(workflow).toContain('environment: exploration-smoke');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
    expect(workflow).toContain('test "$SOURCE_SHA" = "$GITHUB_SHA"');
    expect(workflow).toContain(
      'APPLY EXACT SES READS AND APP RUNNER DOMAIN AUTHORITY WITH NO SEND OR DNS AUTHORITY',
    );
    expect(workflow).toContain(
      'aws-actions/configure-aws-credentials@61815dcd50bd041e203e49132bacad1fd04d2708',
    );
    expect(workflow).toContain(
      'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09',
    );
    expect(workflow).not.toContain('iam put-role-policy');
    expect(workflow).not.toContain('sesv2 put-');
    expect(workflow).not.toContain('sesv2 create-');
    expect(workflow).not.toContain('sesv2 update-');
    expect(workflow).not.toContain('sesv2 delete-');
    expect(workflow).not.toContain('sesv2 send-');
    expect(workflow).not.toContain('apprunner associate-custom-domain');
    expect(workflow).not.toContain('route53 change-resource-record-sets');
    expect(workflow).not.toContain('cloudformation list-stack-resources');
  });

  it('executes a first apply through only the scoped deploy role and restores OIDC', async () => {
    const result = await runScenario({ existingStack: false });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.result).toEqual({ state: 'applied' });
    expect(result.changeSetRequest).toMatchObject({
      Capabilities: ['CAPABILITY_NAMED_IAM'],
      ChangeSetName: 'psd-eoc-ses-readback-1-1',
      ChangeSetType: 'CREATE',
      ClientToken: 'psd-eoc-ses-readback-1-1',
      OnStackFailure: 'ROLLBACK',
      RoleARN: `arn:aws:iam::${accountId}:role/cdk-hnb659fds-cfn-exec-role-${accountId}-${region}`,
      StackName: 'PsdEocExplorationSmokeSesReadbackPolicy',
    });
    expect(result.awsCalls).toContain('sts:assume-role:oidc-access');
    expect(
      result.awsCalls
        .filter((call) => call.startsWith('cloudformation:'))
        .every((call) => call.endsWith(':deploy-access')),
    ).toBe(true);
    expect(
      result.awsCalls
        .filter((call) => call.startsWith('iam:') || call.startsWith('sesv2:'))
        .every((call) => call.endsWith(':oidc-access')),
    ).toBe(true);
    expect(result.awsCalls).toContain('sts:get-caller-identity:oidc-access');
    expect(result.awsCalls).toContain('sts:get-caller-identity:deploy-access');
    expect(
      result.awsCalls.filter(
        (call) => call === 'iam:simulate-principal-policy:oidc-access',
      ),
    ).toHaveLength(7);
    expect(result.awsCalls).not.toContain(
      'cloudformation:list-stack-resources:deploy-access',
    );
  });

  it('accepts an exact idempotent no-change response with reordered event types and does not execute it', async () => {
    const result = await runScenario({ existingStack: true });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.result).toEqual({ state: 'already-applied' });
    expect(result.changeSetRequest).toMatchObject({ ChangeSetType: 'UPDATE' });
    expect(result.awsCalls).not.toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:list-stack-resources:deploy-access',
    );
  });

  it.each(['missing', 'superset'] as const)(
    'fails closed when SES readback has a %s event-type set',
    async (eventTypeMismatch) => {
      const result = await runScenario({
        eventTypeMismatch,
        existingStack: true,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.result).toEqual({ state: 'already-applied' });
      expect(result.awsCalls).not.toContain(
        'cloudformation:execute-change-set:deploy-access',
      );
      expect(result.awsCalls).not.toContain(
        'cloudformation:list-stack-resources:deploy-access',
      );
    },
  );

  it('updates only the exact authorized SES-only predecessor without replacement', async () => {
    const result = await runScenario({
      existingPredecessor: true,
      existingStack: true,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.result).toEqual({ state: 'applied' });
    expect(result.changeSetRequest).toMatchObject({ ChangeSetType: 'UPDATE' });
    expect(result.awsCalls).toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:list-stack-resources:deploy-access',
    );
  });

  it('fails closed before creating a change set when the retained template is neither authorized version', async () => {
    const result = await runScenario({
      existingPredecessor: true,
      existingStack: true,
      templateMismatch: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.awsCalls).not.toContain(
      'cloudformation:create-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
  });

  it('fails closed when the authorized predecessor update is not one exact non-replacing policy modification', async () => {
    const result = await runScenario({
      changeSetMismatch: true,
      existingPredecessor: true,
      existingStack: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.awsCalls).not.toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
  });

  it('resumes an exact available CREATE after interruption without creating a second change set', async () => {
    const result = await runScenario({
      existingStack: false,
      interruptedCreate: true,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.result).toEqual({ state: 'resumed-interrupted-create' });
    expect(result.changeSetRequest).toBeUndefined();
    expect(result.awsCalls).toContain(
      'cloudformation:list-change-sets:deploy-access',
    );
    expect(result.awsCalls).toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:create-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:list-stack-resources:deploy-access',
    );
  });

  it('fails closed before execution when the change set is not the exact one-resource add', async () => {
    const result = await runScenario({
      changeSetMismatch: true,
      existingStack: false,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.awsCalls).not.toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
  });

  it('fails closed on a mismatched interrupted CREATE instead of resuming it', async () => {
    const result = await runScenario({
      changeSetMismatch: true,
      existingStack: false,
      interruptedCreate: true,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.result).toBeUndefined();
    expect(result.awsCalls).not.toContain(
      'cloudformation:create-change-set:deploy-access',
    );
    expect(result.awsCalls).not.toContain(
      'cloudformation:execute-change-set:deploy-access',
    );
  });
});
