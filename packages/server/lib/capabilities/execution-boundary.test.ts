import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import {
  invokeAuthorizedCapabilityHandler,
  registerCapabilityHandler,
  type CapabilityExecutionAuthorizer,
  type CapabilityPrincipalKind,
  type InvocationSource,
} from '@psd-eoc/contracts';
import ts from 'typescript';

import { REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS } from './engine';

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const LOWER_TIER_PRODUCTION_ALLOWLIST = Object.freeze([
  'packages/contracts/src/capability-catalog.ts',
  'packages/server/app/api/internal/delivery-state/runtime.ts',
  'packages/server/app/api/jobs/roster-sync/runtime.ts',
  'packages/server/app/api/webhooks/ses/runtime.ts',
  'packages/server/lib/capabilities/engine.ts',
  'packages/server/lib/notify/dispatcher.ts',
  'packages/server/lib/notify/reconcile.ts',
  'packages/server/lib/notify/sms-policy.ts',
  'packages/server/scripts/operations/sync-access-membership.ts',
] as const);

const SESSION_REPLAY_ENGINE_ALLOWLIST = Object.freeze([
  'packages/server/lib/auth/sessions.ts',
  'packages/server/lib/capabilities/engine.ts',
] as const);

const REPOSITORY_AUDITED_OIDC_ALLOWLIST = Object.freeze([
  'packages/server/app/(auth)/auth/callback/route.ts',
  'packages/server/app/api/auth/mobile/oidc/exchange/route.ts',
  'packages/server/lib/capabilities/engine.ts',
] as const);

function isProductionSource(path: string): boolean {
  return (
    (path.startsWith('packages/') || path.startsWith('workers/')) &&
    (path.endsWith('.ts') || path.endsWith('.tsx')) &&
    !path.endsWith('.test.ts') &&
    !path.endsWith('.test.tsx') &&
    !path.endsWith('.integration.test.ts') &&
    !path.includes('/e2e/') &&
    !path.includes('/node_modules/') &&
    !path.includes('/.next/')
  );
}

function productionSources(): readonly string[] {
  const paths: string[] = [];
  const glob = new Bun.Glob('{packages,workers}/**/*.{ts,tsx}');
  for (const path of glob.scanSync({ cwd: repositoryRoot })) {
    if (isProductionSource(path)) paths.push(path);
  }
  return paths.sort();
}

function source(path: string): string {
  return readFileSync(`${repositoryRoot}/${path}`, 'utf8');
}

interface ProgramInspection {
  readonly checker: ts.TypeChecker;
  readonly logicalPaths: ReadonlyMap<string, string>;
  readonly program: ts.Program;
}

const COMPILER_OPTIONS = Object.freeze({
  allowJs: false,
  jsx: ts.JsxEmit.Preserve,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  noEmit: true,
  skipLibCheck: true,
  target: ts.ScriptTarget.ES2022,
} satisfies ts.CompilerOptions);

function createProductionInspection(): ProgramInspection {
  const logicalPaths = new Map<string, string>();
  for (const path of productionSources()) {
    logicalPaths.set(resolve(repositoryRoot, path), path);
  }
  const program = ts.createProgram({
    rootNames: [...logicalPaths.keys()],
    options: COMPILER_OPTIONS,
  });
  return Object.freeze({
    checker: program.getTypeChecker(),
    logicalPaths,
    program,
  });
}

function createVirtualInspection(
  sources: Readonly<Record<string, string>>,
): ProgramInspection {
  const virtualRoot = '/virtual/capability-boundary';
  const virtualSources = new Map<string, string>();
  const logicalPaths = new Map<string, string>();
  for (const [path, contents] of Object.entries(sources)) {
    const fileName = resolve(virtualRoot, path);
    virtualSources.set(fileName, contents);
    logicalPaths.set(fileName, path);
  }

  const baseHost = ts.createCompilerHost(COMPILER_OPTIONS);
  const host: ts.CompilerHost = {
    ...baseHost,
    directoryExists(directoryName) {
      return (
        directoryName === '/virtual' ||
        directoryName === virtualRoot ||
        baseHost.directoryExists?.(directoryName) === true
      );
    },
    fileExists(fileName) {
      return virtualSources.has(fileName) || baseHost.fileExists(fileName);
    },
    getSourceFile(fileName, languageVersion) {
      const contents = virtualSources.get(fileName);
      return contents === undefined
        ? baseHost.getSourceFile(fileName, languageVersion)
        : ts.createSourceFile(fileName, contents, languageVersion, true);
    },
    readFile(fileName) {
      return virtualSources.get(fileName) ?? baseHost.readFile(fileName);
    },
  };
  const program = ts.createProgram({
    host,
    rootNames: [...virtualSources.keys()],
    options: COMPILER_OPTIONS,
  });
  return Object.freeze({
    checker: program.getTypeChecker(),
    logicalPaths,
    program,
  });
}

function resolveAlias(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  let resolved = symbol;
  const visited = new Set<ts.Symbol>();
  while (
    (resolved.flags & ts.SymbolFlags.Alias) !== 0 &&
    !visited.has(resolved)
  ) {
    visited.add(resolved);
    resolved = checker.getAliasedSymbol(resolved);
  }
  return resolved;
}

function symbolsEquivalent(left: ts.Symbol, right: ts.Symbol): boolean {
  if (left === right) return true;
  const leftDeclarations = left.declarations;
  const rightDeclarations = right.declarations;
  return (
    leftDeclarations !== undefined &&
    rightDeclarations !== undefined &&
    leftDeclarations.some((declaration) =>
      rightDeclarations.includes(declaration),
    )
  );
}

function symbolSetHas(
  symbols: ReadonlySet<ts.Symbol>,
  candidate: ts.Symbol,
): boolean {
  for (const symbol of symbols) {
    if (symbolsEquivalent(symbol, candidate)) return true;
  }
  return false;
}

function sourceFileFor(
  inspection: ProgramInspection,
  logicalPath: string,
): ts.SourceFile {
  const sourceFile = inspection.program
    .getSourceFiles()
    .find(
      (candidate) =>
        inspection.logicalPaths.get(resolve(candidate.fileName)) ===
        logicalPath,
    );
  if (sourceFile === undefined) {
    throw new Error(`Missing source file in boundary program: ${logicalPath}`);
  }
  return sourceFile;
}

function exportedFunctionSymbol(
  inspection: ProgramInspection,
  ownerPath: string,
  functionName: string,
): ts.Symbol {
  const declaration = sourceFileFor(inspection, ownerPath).statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  const symbol =
    declaration?.name === undefined
      ? undefined
      : inspection.checker.getSymbolAtLocation(declaration.name);
  if (symbol === undefined) {
    throw new Error(
      `Missing exported boundary function ${functionName} in ${ownerPath}`,
    );
  }
  return resolveAlias(inspection.checker, symbol);
}

function interfacePropertySymbol(
  inspection: ProgramInspection,
  ownerPath: string,
  interfaceName: string,
  propertyName: string,
): ts.Symbol {
  const declaration = sourceFileFor(inspection, ownerPath).statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) &&
      statement.name.text === interfaceName,
  );
  const property = declaration?.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) &&
      ts.isIdentifier(member.name) &&
      member.name.text === propertyName,
  );
  const symbol =
    property === undefined
      ? undefined
      : inspection.checker.getSymbolAtLocation(property.name);
  if (symbol === undefined) {
    throw new Error(
      `Missing ${interfaceName}.${propertyName} property in ${ownerPath}.`,
    );
  }
  return resolveAlias(inspection.checker, symbol);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let unwrapped = expression;
  while (
    ts.isParenthesizedExpression(unwrapped) ||
    ts.isAsExpression(unwrapped) ||
    ts.isSatisfiesExpression(unwrapped) ||
    ts.isNonNullExpression(unwrapped) ||
    ts.isAwaitExpression(unwrapped)
  ) {
    unwrapped = unwrapped.expression;
  }
  return unwrapped;
}

function literalPropertyName(
  inspection: ProgramInspection,
  expression: ts.Expression,
): string | undefined {
  const unwrapped = unwrapExpression(expression);
  if (ts.isStringLiteralLike(unwrapped)) return unwrapped.text;
  const type = inspection.checker.getTypeAtLocation(unwrapped);
  return (type.flags & ts.TypeFlags.StringLiteral) !== 0
    ? (type as ts.StringLiteralType).value
    : undefined;
}

function expressionSymbol(
  inspection: ProgramInspection,
  expression: ts.Expression,
): ts.Symbol | undefined {
  const unwrapped = unwrapExpression(expression);
  let symbol = inspection.checker.getSymbolAtLocation(unwrapped);
  if (
    symbol === undefined &&
    ts.isElementAccessExpression(unwrapped) &&
    unwrapped.argumentExpression !== undefined
  ) {
    const propertyName = literalPropertyName(
      inspection,
      unwrapped.argumentExpression,
    );
    if (propertyName !== undefined) {
      symbol = inspection.checker
        .getTypeAtLocation(unwrapped.expression)
        .getProperty(propertyName);
    }
  }
  return symbol === undefined
    ? undefined
    : resolveAlias(inspection.checker, symbol);
}

function declaredSymbol(
  inspection: ProgramInspection,
  name: ts.BindingName | ts.PropertyName | undefined,
): ts.Symbol | undefined {
  return name === undefined
    ? undefined
    : inspection.checker.getSymbolAtLocation(name);
}

function bindingPropertyName(
  inspection: ProgramInspection,
  element: ts.BindingElement,
): string | undefined {
  const propertyName = element.propertyName;
  if (propertyName === undefined) {
    return ts.isIdentifier(element.name) ? element.name.text : undefined;
  }
  if (ts.isIdentifier(propertyName) || ts.isStringLiteralLike(propertyName)) {
    return propertyName.text;
  }
  return ts.isComputedPropertyName(propertyName)
    ? literalPropertyName(inspection, propertyName.expression)
    : undefined;
}

function passThroughCallee(
  declaration:
    | ts.ArrowFunction
    | ts.FunctionDeclaration
    | ts.FunctionExpression
    | ts.MethodDeclaration,
): ts.Expression | undefined {
  const body = declaration.body;
  if (body === undefined) return undefined;
  let returned: ts.Expression | undefined;
  if (ts.isBlock(body)) {
    const onlyStatement = body.statements[0];
    returned =
      body.statements.length === 1 &&
      onlyStatement !== undefined &&
      ts.isReturnStatement(onlyStatement)
        ? onlyStatement.expression
        : undefined;
  } else {
    returned = body;
  }
  if (returned === undefined) return undefined;
  const expression = unwrapExpression(returned);
  return ts.isCallExpression(expression) ? expression.expression : undefined;
}

function signatureOwnerSymbol(
  inspection: ProgramInspection,
  call: ts.CallExpression,
): ts.Symbol | undefined {
  let declaration: ts.Node | undefined =
    inspection.checker.getResolvedSignature(call)?.declaration;
  while (declaration !== undefined && !ts.isSourceFile(declaration)) {
    if (
      (ts.isFunctionDeclaration(declaration) ||
        ts.isMethodDeclaration(declaration) ||
        ts.isPropertySignature(declaration) ||
        ts.isMethodSignature(declaration) ||
        ts.isVariableDeclaration(declaration) ||
        ts.isPropertyAssignment(declaration)) &&
      declaration.name !== undefined
    ) {
      const symbol = declaredSymbol(inspection, declaration.name);
      if (symbol !== undefined) return resolveAlias(inspection.checker, symbol);
    }
    declaration = declaration.parent;
  }
  return undefined;
}

const trackedSymbolCache = new WeakMap<ts.Symbol, ReadonlySet<ts.Symbol>>();

function trackedBoundarySymbols(
  inspection: ProgramInspection,
  target: ts.Symbol,
  propagationStops: ReadonlySet<ts.Symbol> = new Set(),
): ReadonlySet<ts.Symbol> {
  const cached =
    propagationStops.size === 0 ? trackedSymbolCache.get(target) : undefined;
  if (cached !== undefined) return cached;

  const tracked = new Set<ts.Symbol>([target]);
  const matches = (symbol: ts.Symbol | undefined): boolean =>
    symbol !== undefined &&
    symbolSetHas(tracked, resolveAlias(inspection.checker, symbol));
  const add = (symbol: ts.Symbol | undefined): void => {
    if (symbol !== undefined) {
      const resolved = resolveAlias(inspection.checker, symbol);
      if (
        !symbolSetHas(propagationStops, resolved) &&
        !symbolSetHas(tracked, resolved)
      ) {
        tracked.add(resolved);
      }
    }
  };

  let sizeBeforePass = -1;
  while (sizeBeforePass !== tracked.size) {
    sizeBeforePass = tracked.size;
    for (const sourceFile of inspection.program.getSourceFiles()) {
      if (!inspection.logicalPaths.has(resolve(sourceFile.fileName))) continue;
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer !== undefined
        ) {
          const initializer = unwrapExpression(node.initializer);
          if (
            matches(expressionSymbol(inspection, initializer)) ||
            ((ts.isArrowFunction(initializer) ||
              ts.isFunctionExpression(initializer)) &&
              matches(
                expressionSymbol(
                  inspection,
                  passThroughCallee(initializer) ?? initializer,
                ),
              ))
          ) {
            add(declaredSymbol(inspection, node.name));
          }
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
          const assignedValue = unwrapExpression(node.right);
          if (
            matches(expressionSymbol(inspection, assignedValue)) ||
            ((ts.isArrowFunction(assignedValue) ||
              ts.isFunctionExpression(assignedValue)) &&
              matches(
                expressionSymbol(
                  inspection,
                  passThroughCallee(assignedValue) ?? assignedValue,
                ),
              ))
          ) {
            add(expressionSymbol(inspection, node.left));
          }
        }
        if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
          const callee = passThroughCallee(node);
          if (
            callee !== undefined &&
            matches(expressionSymbol(inspection, callee))
          ) {
            add(declaredSymbol(inspection, node.name));
          }
        }
        if (
          ts.isVariableDeclaration(node) &&
          ts.isObjectBindingPattern(node.name) &&
          node.initializer !== undefined
        ) {
          const sourceType = inspection.checker.getTypeAtLocation(
            node.initializer,
          );
          for (const element of node.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const propertyName = bindingPropertyName(inspection, element);
            if (
              propertyName !== undefined &&
              matches(sourceType.getProperty(propertyName))
            ) {
              add(declaredSymbol(inspection, element.name));
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  if (propagationStops.size === 0) trackedSymbolCache.set(target, tracked);
  return tracked;
}

function referenceConsumers(
  inspection: ProgramInspection,
  target: ts.Symbol,
  propagationStops: ReadonlySet<ts.Symbol> = new Set(),
): readonly string[] {
  const tracked = trackedBoundarySymbols(inspection, target, propagationStops);
  const consumers = new Set<string>();
  for (const sourceFile of inspection.program.getSourceFiles()) {
    const logicalPath = inspection.logicalPaths.get(
      resolve(sourceFile.fileName),
    );
    if (logicalPath === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const symbol = inspection.checker.getSymbolAtLocation(node);
        if (
          symbol !== undefined &&
          symbolSetHas(tracked, resolveAlias(inspection.checker, symbol))
        ) {
          consumers.add(logicalPath);
        }
      }
      if (ts.isCallExpression(node)) {
        const symbol = signatureOwnerSymbol(inspection, node);
        if (symbol !== undefined && symbolSetHas(tracked, symbol)) {
          consumers.add(logicalPath);
        }
      }
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression !== undefined
      ) {
        const symbol = expressionSymbol(inspection, node);
        if (symbol !== undefined && symbolSetHas(tracked, symbol)) {
          consumers.add(logicalPath);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...consumers].sort();
}

function functionConsumers(
  inspection: ProgramInspection,
  ownerPath: string,
  functionName: string,
  propagationStops: ReadonlySet<ts.Symbol> = new Set(),
): readonly string[] {
  return referenceConsumers(
    inspection,
    exportedFunctionSymbol(inspection, ownerPath, functionName),
    propagationStops,
  );
}

function identifierConsumers(
  inspection: ProgramInspection,
  identifierName: string,
): readonly string[] {
  const consumers = new Set<string>();
  for (const sourceFile of inspection.program.getSourceFiles()) {
    const logicalPath = inspection.logicalPaths.get(
      resolve(sourceFile.fileName),
    );
    if (logicalPath === undefined) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === identifierName) {
        consumers.add(logicalPath);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return [...consumers].sort();
}

function moduleExportConsumers(
  inspection: ProgramInspection,
  exportName: string,
): readonly string[] {
  const consumers: string[] = [];
  for (const sourceFile of inspection.program.getSourceFiles()) {
    const logicalPath = inspection.logicalPaths.get(
      resolve(sourceFile.fileName),
    );
    if (logicalPath === undefined) continue;
    const moduleSymbol = inspection.checker.getSymbolAtLocation(sourceFile);
    if (
      moduleSymbol !== undefined &&
      inspection.checker
        .getExportsOfModule(moduleSymbol)
        .some((symbol) => symbol.name === exportName)
    ) {
      consumers.push(logicalPath);
    }
  }
  return consumers.sort();
}

const productionInspection = createProductionInspection();

let cachedLowerTierConsumers: readonly string[] | undefined;

function lowerTierProductionConsumers(): readonly string[] {
  if (cachedLowerTierConsumers !== undefined) {
    return cachedLowerTierConsumers;
  }
  const enginePath = 'packages/server/lib/capabilities/engine.ts';
  const intentionalUpperTierSeams = new Set([
    exportedFunctionSymbol(
      productionInspection,
      enginePath,
      'executeAuthorizedCapabilityQuery',
    ),
    exportedFunctionSymbol(
      productionInspection,
      enginePath,
      'executeRepositoryAuditedOidcCompletion',
    ),
  ]);
  cachedLowerTierConsumers = functionConsumers(
    productionInspection,
    'packages/contracts/src/capability-catalog.ts',
    'invokeAuthorizedCapabilityHandler',
    intentionalUpperTierSeams,
  );
  return cachedLowerTierConsumers;
}

interface DisallowedLowerTierContext {
  readonly surface: 'browser' | 'rest' | 'mcp' | 'mobile' | 'job' | 'webhook';
  readonly principalKind: CapabilityPrincipalKind;
  readonly source: InvocationSource;
  readonly auditHistory: unknown[];
}

const REPRESENTATIVE_SURFACE_ADAPTERS = Object.freeze({
  browser: 'packages/server/app/(admin)/event-types/api/route.ts',
  rest: 'packages/server/lib/agents/gateway.ts',
  mcp: 'packages/mcp/src/http.ts',
  mobile: 'packages/server/app/api/mobile/start/_lib/http.ts',
  job: 'packages/server/app/api/jobs/roster-sync/runtime.ts',
  webhook: 'packages/server/app/api/webhooks/ses/runtime.ts',
} as const);

describe('capability execution source boundary', () => {
  test('symbol analysis follows aliased imports through re-exports', () => {
    const inspection = createVirtualInspection({
      'bridge.ts':
        "export { invokeAuthorizedCapabilityHandler as runCapability } from './contracts';",
      'contracts.ts':
        'export function invokeAuthorizedCapabilityHandler(): void {}',
      'route.ts':
        "import { runCapability as hiddenBoundary } from './bridge'; hiddenBoundary();",
    });
    expect(
      functionConsumers(
        inspection,
        'contracts.ts',
        'invokeAuthorizedCapabilityHandler',
      ),
    ).toEqual(['bridge.ts', 'contracts.ts', 'route.ts']);
  });

  test('symbol analysis follows value aliases and pass-through wrappers', () => {
    const inspection = createVirtualInspection({
      'assigned-route.ts':
        "import { sideDoor } from './assignment'; sideDoor();",
      'assignment.ts':
        "import { invokeAuthorizedCapabilityHandler } from './contracts'; export let sideDoor: typeof invokeAuthorizedCapabilityHandler; sideDoor = invokeAuthorizedCapabilityHandler;",
      'bridge.ts':
        "import { invokeAuthorizedCapabilityHandler } from './contracts'; export const runCapability = invokeAuthorizedCapabilityHandler;",
      'contracts.ts':
        'export function invokeAuthorizedCapabilityHandler(): void {}',
      'route.ts':
        "import { runCapability } from './bridge'; import { wrappedCapability } from './wrapper'; runCapability(); wrappedCapability();",
      'wrapper.ts':
        "import { invokeAuthorizedCapabilityHandler } from './contracts'; export const wrappedCapability = () => invokeAuthorizedCapabilityHandler();",
    });
    expect(
      functionConsumers(
        inspection,
        'contracts.ts',
        'invokeAuthorizedCapabilityHandler',
      ),
    ).toEqual([
      'assigned-route.ts',
      'assignment.ts',
      'bridge.ts',
      'contracts.ts',
      'route.ts',
      'wrapper.ts',
    ]);
  });

  test('symbol analysis resolves computed boundary access', () => {
    const inspection = createVirtualInspection({
      'contracts.ts':
        'export function invokeAuthorizedCapabilityHandler(): void {}',
      'route.ts':
        "import * as contracts from './contracts'; contracts['invokeAuthorizedCapabilityHandler']();",
      'variable-key.ts':
        "import * as contracts from './contracts'; const boundaryKey = 'invokeAuthorizedCapabilityHandler' as const; contracts[boundaryKey]();",
    });
    expect(
      functionConsumers(
        inspection,
        'contracts.ts',
        'invokeAuthorizedCapabilityHandler',
      ),
    ).toEqual(['contracts.ts', 'route.ts', 'variable-key.ts']);
  });

  test('symbol analysis follows destructured registered handlers', () => {
    const inspection = createVirtualInspection({
      'computed.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; registration['handler']();",
      'computed-binding.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; const propertyKey = 'handler' as const; const { [propertyKey]: hiddenHandler } = registration; hiddenHandler();",
      'computed-variable.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; const propertyKey = 'handler' as const; registration[propertyKey]();",
      'contracts.ts':
        'export interface RegisteredCapabilityHandler { readonly handler: () => void; }',
      'route.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; const { handler: hiddenHandler } = registration; hiddenHandler();",
      'spread-binding.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; const { handler: hiddenHandler } = { ...registration }; hiddenHandler();",
      'spread-call.ts':
        "import type { RegisteredCapabilityHandler } from './contracts'; declare const registration: RegisteredCapabilityHandler; const copy = { ...registration }; copy.handler();",
    });
    expect(
      referenceConsumers(
        inspection,
        interfacePropertySymbol(
          inspection,
          'contracts.ts',
          'RegisteredCapabilityHandler',
          'handler',
        ),
      ),
    ).toEqual([
      'computed-binding.ts',
      'computed-variable.ts',
      'computed.ts',
      'contracts.ts',
      'route.ts',
      'spread-binding.ts',
      'spread-call.ts',
    ]);
  });

  test('lower-tier imports stay on the machine and webhook allowlist', () => {
    const consumers = lowerTierProductionConsumers();
    expect(consumers).toEqual([...LOWER_TIER_PRODUCTION_ALLOWLIST]);
  }, 15_000);

  test('capability-boundary-denial fails closed without mutating audit history on every surface', async () => {
    let handlerCalls = 0;
    const registration = registerCapabilityHandler(
      'get-admin-readiness',
      async () => {
        handlerCalls += 1;
        throw new Error('A denied lower-tier handler must never run.');
      },
    );
    const authorizer: CapabilityExecutionAuthorizer<DisallowedLowerTierContext> =
      {
        authorize({ invocationPolicy, context }) {
          if (
            !invocationPolicy.principalKinds.includes(context.principalKind) ||
            !invocationPolicy.sources.includes(context.source)
          ) {
            throw new Error(`LOWER_TIER_DENIED:${context.surface}`);
          }
          context.auditHistory.push({
            action: 'get-admin-readiness',
            outcome: 'success',
          });
        },
      };
    const attempts = Object.freeze([
      { surface: 'browser', principalKind: 'agent', source: 'web' },
      { surface: 'rest', principalKind: 'system', source: 'agent-rest' },
      { surface: 'mcp', principalKind: 'system', source: 'mcp' },
      { surface: 'mobile', principalKind: 'agent', source: 'mobile' },
      { surface: 'job', principalKind: 'human', source: 'scheduled-job' },
      { surface: 'webhook', principalKind: 'human', source: 'webhook' },
    ] as const);
    const lowerTierConsumers = new Set(lowerTierProductionConsumers());

    for (const attempt of attempts) {
      const adapterPath = REPRESENTATIVE_SURFACE_ADAPTERS[attempt.surface];
      if (attempt.surface === 'job' || attempt.surface === 'webhook') {
        expect(lowerTierConsumers.has(adapterPath)).toBe(true);
      } else {
        expect(lowerTierConsumers.has(adapterPath)).toBe(false);
      }
      const auditHistory: unknown[] = [];
      await expect(
        invokeAuthorizedCapabilityHandler(
          registration,
          {},
          {
            context: Object.freeze({ ...attempt, auditHistory }),
            humanActionResolutionContext: null,
            safetyResolver: null,
            authorizer,
          },
        ),
      ).rejects.toThrow(`LOWER_TIER_DENIED:${attempt.surface}`);
      expect(auditHistory).toEqual([]);
    }
    expect(handlerCalls).toBe(0);
  });

  test('production exports no ambiguous executeCapability function', () => {
    const ambiguous = moduleExportConsumers(
      productionInspection,
      'executeCapability',
    );
    expect(ambiguous).toEqual([]);
  });

  test('the repository-audited pre-session exception stays literal-ID and exact', () => {
    const consumers = functionConsumers(
      productionInspection,
      'packages/server/lib/capabilities/engine.ts',
      'executeRepositoryAuditedOidcCompletion',
    );
    expect(consumers).toEqual([...REPOSITORY_AUDITED_OIDC_ALLOWLIST]);
    expect(source('packages/server/lib/capabilities/engine.ts')).toMatch(
      /RegisteredCapabilityHandler<\s*'complete-oidc-sign-in'/u,
    );
  });

  test('session mutation replays stay inside their exact engine entry points', () => {
    for (const entryPoint of [
      'executeAuditedSessionReplaySuccess',
      'executeAuditedRefreshReplayDenial',
    ]) {
      const consumers = functionConsumers(
        productionInspection,
        'packages/server/lib/capabilities/engine.ts',
        entryPoint,
      );
      expect(consumers).toEqual([...SESSION_REPLAY_ENGINE_ALLOWLIST]);
    }
    expect(source('packages/server/lib/capabilities/engine.ts')).toMatch(
      /type AuditedSessionReplayCapabilityId = 'refresh-session' \| 'revoke-session'/u,
    );
  });

  test('no unrestricted persisted-service mutation bridge remains', () => {
    const consumers = identifierConsumers(
      productionInspection,
      'executePersistedCapabilityService',
    );
    expect(consumers).toEqual([]);
  });

  test('repository-owned idempotency stays on the exact audited allowlist', () => {
    expect(REPOSITORY_OWNED_MUTATION_CAPABILITY_IDS).toEqual([
      'refresh-session',
      'revoke-session',
      'create-event-type-draft',
      'update-event-type-draft',
      'publish-event-type-version',
      'issue-agent-api-key',
      'revoke-agent-api-key',
    ]);
  });

  test('shared library code never imports from a Next app directory', () => {
    const violations = productionSources()
      .filter((path) => path.startsWith('packages/server/lib/'))
      .filter((path) => /from\s+['"][^'"]*\/app\//u.test(source(path)));
    expect(violations).toEqual([]);
  });

  test('only the contracts primitive invokes a registered handler directly', () => {
    const consumers = referenceConsumers(
      productionInspection,
      interfacePropertySymbol(
        productionInspection,
        'packages/contracts/src/capability-catalog.ts',
        'RegisteredCapabilityHandler',
        'handler',
      ),
    );
    expect(consumers).toEqual(['packages/contracts/src/capability-catalog.ts']);
  });
});
