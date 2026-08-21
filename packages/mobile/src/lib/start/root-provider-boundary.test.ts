import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const LAYOUT_PATH = new URL('../../app/_layout.tsx', import.meta.url);
const OUTCOME_CHECK_SCREEN_PATHS = [
  new URL('../../app/index.tsx', import.meta.url),
  new URL('../../app/start/index.tsx', import.meta.url),
] as const;

function returnedExpression(
  sourceFile: ts.SourceFile,
  functionName: string,
): ts.Expression {
  const declaration = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === functionName,
  );
  const returnStatement = declaration?.body?.statements.find(
    (statement): statement is ts.ReturnStatement =>
      ts.isReturnStatement(statement),
  );
  if (returnStatement?.expression === undefined) {
    throw new Error(`${functionName} must return the protected app tree.`);
  }
  return unwrapParentheses(returnStatement.expression);
}

function unwrapParentheses(expression: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(expression)
    ? unwrapParentheses(expression.expression)
    : expression;
}

function jsxElement(expression: ts.Expression, label: string): ts.JsxElement {
  if (!ts.isJsxElement(expression)) {
    throw new Error(`${label} must be a JSX element.`);
  }
  return expression;
}

function elementChildren(element: ts.JsxElement): readonly ts.JsxElement[] {
  return element.children.filter(ts.isJsxElement);
}

function stackScreenNames(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): readonly string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (
      ts.isJsxSelfClosingElement(current) &&
      current.tagName.getText(sourceFile) === 'Stack.Screen'
    ) {
      const nameAttribute = current.attributes.properties.find(
        (property): property is ts.JsxAttribute =>
          ts.isJsxAttribute(property) &&
          property.name.getText(sourceFile) === 'name',
      );
      if (
        nameAttribute?.initializer !== undefined &&
        ts.isStringLiteral(nameAttribute.initializer)
      ) {
        names.push(nameAttribute.initializer.text);
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return names;
}

function outcomeCheckResetDependencies(
  sourceFile: ts.SourceFile,
): readonly string[] {
  let dependencies: readonly string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect'
    ) {
      const [callback, dependencyValue] = node.arguments;
      if (
        callback !== undefined &&
        callback.getText(sourceFile).includes('setCheckingOutcome(false)') &&
        callback.getText(sourceFile).includes('setOutcomeCheckError(null)') &&
        dependencyValue !== undefined &&
        ts.isArrayLiteralExpression(dependencyValue)
      ) {
        dependencies = dependencyValue.elements.map((element) =>
          element.getText(sourceFile),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (dependencies === null) {
    throw new Error('The outcome-check reset effect is missing.');
  }
  return dependencies;
}

describe('root layout provider placement', () => {
  test('selects the start home when authentication unlocks the protected routes', async () => {
    const source = await Bun.file(LAYOUT_PATH).text();
    const sourceFile = ts.createSourceFile(
      '_layout.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const stack = jsxElement(
      returnedExpression(sourceFile, 'AuthenticatedStack'),
      'AuthenticatedStack',
    );
    const routeNames = stackScreenNames(stack, sourceFile);

    expect(routeNames).toContain('(app)');
    expect(routeNames[0]).toBe('index');
  });

  test('keeps the OIDC callback reachable without a session', async () => {
    // Android delivers psdeoc://auth/callback as an OS intent, and it arrives
    // before there is anything to guard on. A guarded — or missing — route puts
    // the authorization code back on Expo Router's Unmatched Route, which is
    // the defect in issue #290.
    const source = await Bun.file(LAYOUT_PATH).text();
    const sourceFile = ts.createSourceFile(
      '_layout.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const stack = jsxElement(
      returnedExpression(sourceFile, 'AuthenticatedStack'),
      'AuthenticatedStack',
    );
    const routeNames = stackScreenNames(stack, sourceFile);

    expect(routeNames).toContain('auth/callback');
    // Last, so it is a destination rather than the anchor route.
    expect(routeNames[0]).not.toBe('auth/callback');

    const guardedNames: string[] = [];
    const collectGuarded = (node: ts.Node): void => {
      if (
        ts.isJsxElement(node) &&
        node.openingElement.tagName.getText(sourceFile) === 'Stack.Protected'
      ) {
        guardedNames.push(...stackScreenNames(node, sourceFile));
        return;
      }
      ts.forEachChild(node, collectGuarded);
    };
    collectGuarded(stack);

    // Proves the sweep found the guards it is meant to police.
    expect(guardedNames).toContain('(auth)/sign-in');
    expect(guardedNames).not.toContain('auth/callback');
  });

  test('keeps the app-lifetime mutation owner above all authenticated routes', async () => {
    const source = await Bun.file(LAYOUT_PATH).text();
    const sourceFile = ts.createSourceFile(
      '_layout.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );

    const boundary = jsxElement(
      returnedExpression(sourceFile, 'RootProviderBoundary'),
      'RootProviderBoundary',
    );
    expect(boundary.openingElement.tagName.getText(sourceFile)).toBe(
      'AuthProvider',
    );
    const [mutationProvider] = elementChildren(boundary);
    expect(mutationProvider?.openingElement.tagName.getText(sourceFile)).toBe(
      'StartMutationProvider',
    );
    expect(
      mutationProvider?.children.some(
        (child) =>
          ts.isJsxExpression(child) &&
          child.expression?.getText(sourceFile) === 'children',
      ),
    ).toBe(true);

    const layoutContent = jsxElement(
      returnedExpression(sourceFile, 'RootLayoutContent'),
      'RootLayoutContent',
    );
    expect(layoutContent.openingElement.tagName.getText(sourceFile)).toBe(
      'RootProviderBoundary',
    );
    expect(
      layoutContent.children.some(
        (child) =>
          ts.isJsxSelfClosingElement(child) &&
          child.tagName.getText(sourceFile) === 'AuthenticatedStack',
      ),
    ).toBe(true);
  });

  test('reconciles retained mutation truth only after React commits', async () => {
    const source = await Bun.file(
      new URL('./start-mutation-provider.tsx', import.meta.url),
    ).text();
    const sourceFile = ts.createSourceFile(
      'start-mutation-provider.tsx',
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const provider = sourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) &&
        statement.name?.text === 'StartMutationProvider',
    );
    if (provider?.body === undefined) {
      throw new Error('StartMutationProvider must remain a function.');
    }

    const renderPhaseReconciles: ts.CallExpression[] = [];
    let committedReconcile = false;
    const visit = (node: ts.Node, insideCommitEffect: boolean): void => {
      const isCommitEffect =
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useLayoutEffect';
      const inCommitEffect = insideCommitEffect || isCommitEffect;
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.getText(sourceFile) === 'controller' &&
        node.expression.name.text === 'reconcile'
      ) {
        if (inCommitEffect) committedReconcile = true;
        else renderPhaseReconciles.push(node);
      }
      ts.forEachChild(node, (child) => visit(child, inCommitEffect));
    };
    visit(provider.body, false);

    expect(renderPhaseReconciles).toHaveLength(0);
    expect(committedReconcile).toBe(true);
    expect(source).toContain("phase: 'checking-recovery'");
    expect(source).toContain("snapshot.phase === 'checking-recovery'");
  });

  test('cancels stale outcome checks across every connectivity phase change', async () => {
    for (const path of OUTCOME_CHECK_SCREEN_PATHS) {
      const source = await Bun.file(path).text();
      const sourceFile = ts.createSourceFile(
        path.pathname,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );
      const dependencies = outcomeCheckResetDependencies(sourceFile);

      expect(dependencies).toContain('requestAuthenticated');
      expect(dependencies).toContain('isFocused');
      expect(dependencies).toContain('state.phase');
      expect(dependencies).toContain('state.session?.session.id');
    }
  });

  test('keeps unresolved refresh errors truthful and exposes refreshed events read-only', async () => {
    for (const path of OUTCOME_CHECK_SCREEN_PATHS) {
      const source = await Bun.file(path).text();

      expect(source).toContain('unresolvedOutcomeRefreshError()');
      expect(source).toContain(
        'This refresh did not determine the earlier request outcome.',
      );
      expect(source).toContain('activeEvents:');
      expect(source).toContain('outcomeActiveEvents.map((choice) => ({');
      expect(source).toContain('setOutcomeActiveEvents(nextData.activeEvents)');
      expect(source).toContain('setOutcomeActiveEvents(null)');
      expect(source).toContain(
        "return 'PSD EOC could not load fresh active events.",
      );
      expect(source).not.toContain('unresolvedOutcomeRefreshError(error)');
      expect(source).not.toContain('return `${detail} This refresh');
    }
  });

  test('keeps pending joins and result navigation bound to the exact event ID', async () => {
    const screens = [
      { path: OUTCOME_CHECK_SCREEN_PATHS[0], navigation: 'router.push' },
      { path: OUTCOME_CHECK_SCREEN_PATHS[1], navigation: 'router.replace' },
    ] as const;

    for (const { path, navigation } of screens) {
      const source = await Bun.file(path).text();
      expect(source).toContain('mutationSnapshot.eventId === choice.event.id');
      expect(source).not.toContain(
        'mutationSnapshot.eventTypeName === choice.eventTypeName',
      );

      const openEvent = source.indexOf('onOpenEvent={() => {');
      const acknowledge = source.indexOf(
        'if (!startMutation.acknowledge()) return;',
        openEvent,
      );
      const navigate = source.indexOf(`${navigation}({`, acknowledge);
      const target = source.indexOf("pathname: '/events/[id]'", navigate);
      const eventId = source.indexOf(
        'id: mutationSnapshot.completion.eventId',
        target,
      );

      expect(openEvent).toBeGreaterThanOrEqual(0);
      expect(acknowledge).toBeGreaterThan(openEvent);
      expect(navigate).toBeGreaterThan(acknowledge);
      expect(target).toBeGreaterThan(navigate);
      expect(eventId).toBeGreaterThan(target);
    }
  });
});
