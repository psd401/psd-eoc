import { describe, expect, test } from 'bun:test';
import ts from 'typescript';

const LAYOUT_PATH = new URL('../../app/_layout.tsx', import.meta.url);

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

describe('root layout provider placement', () => {
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
});
