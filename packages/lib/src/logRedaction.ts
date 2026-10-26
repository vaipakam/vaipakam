/**
 * Find every place a Worker turns a caught value into text without the
 * formatters (#2759). Test tooling: read by `logRedaction.test.ts` and not
 * exported to any Worker.
 *
 * Every RPC URL this monorepo deploys against carries a provider API key, and
 * viem puts the whole request URL in its error messages, so `String(err)`,
 * `err.message` or the error object itself in a log writes that key wherever
 * the text lands: a Worker or VM log, an HTTP response, an ops alert, a stored
 * row. Truncating does not help, because the URL sits near the start of the
 * message ({@link describeFailure} explains the hazard in full).
 *
 * THE RULE: **a caught value becomes text only through a formatter in
 * `errorDescription.ts`.** It is enforced where the text is MADE rather than
 * where it lands, because the places text lands are open-ended (a log, a
 * response body, a Telegram alert, a database row, a wrapping error) while
 * the ways to make text from a value are few and fixed.
 *
 * A caught value is: the binding of a `catch (x)` clause; the first parameter
 * of a function passed to `.catch(...)` or as the second argument of
 * `.then(...)`; and any local declared or assigned as a bare alias of one.
 *
 * Refused, for a caught value `x`:
 * - `String(x)`, `x.toString()`, `JSON.stringify(x)`;
 * - `x.message`, `x.stack`;
 * - `x` inside a template literal, or as an operand of `+`;
 * - `x` itself as an argument to `console.log/info/warn/error/debug`, which
 *   prints the message and the stack, including inside an object or array
 *   literal there (`{ err }`), and the same inside `JSON.stringify`.
 *
 * Allowed: `x` as an argument of a formatter; `x` on the left of
 * `instanceof`; `x.name`, `x.code`, `x.status`; and text made from `x` whose
 * only use is a yes/no test inside the Worker: the argument of `.test(...)`
 * on a regular expression literal or a named one, or the receiver of
 * `.includes`, `.startsWith` or `.endsWith`. Passing `x` on to another function, rethrowing it, or naming
 * it as a `cause` moves the value without making text from it.
 *
 * What this does not see, and does not claim to: a helper that receives a
 * caught value as an ordinary parameter and makes text from it there. Its
 * parameter is not a caught binding, and following values across calls is a
 * whole-program question. Such helpers call the formatters by review.
 */
import ts from 'typescript';

/** The formatters a caught value may be turned into text by. */
export const SAFE_FORMATTERS = new Set([
  'describeFailure',
  'summarizeFailure',
  'redactedError',
  'redactAndBound',
  'redactSecrets',
]);

const LOG_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const SCALAR_FIELDS = new Set(['name', 'code', 'status']);
const TEXT_FIELDS = new Set(['message', 'stack']);
const BOOLEAN_TEXT_METHODS = new Set(['includes', 'startsWith', 'endsWith']);

/** One place a caught value is made into text without a formatter. */
export interface UnformattedErrorText {
  line: number;
  /** The caught value's name at that site. */
  name: string;
  /** What was done with it. */
  form: string;
  /** The offending expression, first line only. */
  text: string;
  /** Source offsets of the caught identifier at this site. */
  start: number;
  end: number;
}

function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

function isConsoleLog(call: ts.CallExpression): boolean {
  const c = call.expression;
  return (
    ts.isPropertyAccessExpression(c) &&
    ts.isIdentifier(c.expression) &&
    c.expression.text === 'console' &&
    LOG_METHODS.has(c.name.text)
  );
}

/** The binding names a parameter or catch variable introduces. */
function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) out.push(...bindingNames(el.name));
  }
  return out;
}

/** Strip parentheses, `as` / `!` / `satisfies` wrappers. */
function unwrap(n: ts.Expression): ts.Expression {
  let cur = n;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) {
      cur = cur.expression;
    } else {
      return cur;
    }
  }
}

/** The outermost expression that still IS `node` (through wrappers). */
function climb(node: ts.Node): ts.Node {
  let cur = node;
  while (
    cur.parent &&
    (ts.isParenthesizedExpression(cur.parent) ||
      ts.isAsExpression(cur.parent) ||
      ts.isNonNullExpression(cur.parent) ||
      ts.isSatisfiesExpression(cur.parent))
  ) {
    cur = cur.parent;
  }
  return cur;
}

/**
 * Whether text made at `node` is used only as a yes/no test: the argument of
 * `<regex>.test(...)`, or the receiver of `.includes/.startsWith/.endsWith`.
 * A `??` / `||` fallback and a `String(...)` around the text are looked
 * through.
 */
function onlyTested(node: ts.Node): boolean {
  let cur = climb(node);
  for (;;) {
    const p = cur.parent;
    if (
      ts.isBinaryExpression(p) &&
      (p.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        p.operatorToken.kind === ts.SyntaxKind.BarBarToken) &&
      p.left === cur
    ) {
      cur = climb(p);
    } else if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'String') {
      cur = climb(p);
    } else {
      break;
    }
  }
  const p = cur.parent;
  if (ts.isCallExpression(p) && p.arguments.includes(cur as ts.Expression)) {
    const callee = p.expression;
    if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== 'test') return false;
    const receiver = unwrap(callee.expression);
    return ts.isRegularExpressionLiteral(receiver) || ts.isIdentifier(receiver);
  }
  if (ts.isPropertyAccessExpression(p) && p.expression === cur && BOOLEAN_TEXT_METHODS.has(p.name.text)) {
    return ts.isCallExpression(p.parent) && p.parent.expression === p;
  }
  return false;
}

/** Whether `node` sits inside an argument of a formatter call. */
function insideFormatter(node: ts.Node, stop: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur && cur !== stop; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const name = calleeName(cur);
      if (name && SAFE_FORMATTERS.has(name) && cur.arguments.some((a) => a.pos <= node.pos && node.end <= a.end)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Climb from a value through the literals that would carry it whole into a
 * log or a serialisation: an object field (`{ err }`, `{ e: err }`), an
 * array element, a spread, a branch of `?:`.
 */
function climbContainers(node: ts.Node): ts.Node {
  let cur = climb(node);
  for (;;) {
    const p = cur.parent;
    if (
      (ts.isShorthandPropertyAssignment(p) && p.name === cur) ||
      (ts.isPropertyAssignment(p) && p.initializer === cur) ||
      ts.isSpreadAssignment(p) ||
      ts.isSpreadElement(p) ||
      ts.isArrayLiteralExpression(p) ||
      (ts.isConditionalExpression(p) && p.condition !== cur)
    ) {
      cur = climb(p);
    } else if (ts.isObjectLiteralExpression(p)) {
      cur = climb(p);
    } else {
      return cur;
    }
  }
}

/** What, if anything, a use of the caught identifier `id` turns into text. */
function textForm(id: ts.Identifier): { form: string; at: ts.Node } | null {
  const self = climb(id);
  const p = self.parent;

  // Carried whole, inside a literal, into a log or JSON.
  const carried = climbContainers(id);
  if (carried !== self) {
    const cp = carried.parent;
    if (ts.isCallExpression(cp) && cp.arguments.includes(carried as ts.Expression)) {
      if (isConsoleLog(cp)) return { form: 'logged raw', at: cp };
      if (
        ts.isPropertyAccessExpression(cp.expression) &&
        cp.expression.name.text === 'stringify' &&
        ts.isIdentifier(cp.expression.expression) &&
        cp.expression.expression.text === 'JSON'
      ) {
        return { form: 'JSON.stringify()', at: cp };
      }
    }
  }

  if (ts.isPropertyAccessExpression(p) && p.expression === self) {
    if (TEXT_FIELDS.has(p.name.text)) return { form: `.${p.name.text}`, at: p };
    if (p.name.text === 'toString' && ts.isCallExpression(p.parent) && p.parent.expression === p) {
      return { form: '.toString()', at: p.parent };
    }
    return null; // x.name / x.code / x.status / x.cause / anything else read
  }
  if (ts.isElementAccessExpression(p) && p.expression === self) {
    const arg = p.argumentExpression;
    if (ts.isStringLiteral(arg) && TEXT_FIELDS.has(arg.text)) return { form: `['${arg.text}']`, at: p };
    return null;
  }
  if (ts.isCallExpression(p) && p.arguments.includes(self as ts.Expression)) {
    const name = calleeName(p);
    if (ts.isIdentifier(p.expression) && name === 'String') return { form: 'String()', at: p };
    if (
      name === 'stringify' &&
      ts.isPropertyAccessExpression(p.expression) &&
      ts.isIdentifier(p.expression.expression) &&
      p.expression.expression.text === 'JSON'
    ) {
      return { form: 'JSON.stringify()', at: p };
    }
    if (isConsoleLog(p)) return { form: 'logged raw', at: p };
    return null; // handed to another function
  }
  if (ts.isTemplateSpan(p) && p.expression === self) return { form: 'template literal', at: p.parent };
  if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return { form: "'+' operand", at: p };
  }
  return null;
}

/** Every place in one source file where a caught value is made into text without a formatter. */
export function findUnformattedErrorText(fileName: string, source: string): UnformattedErrorText[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  // Seed: caught bindings, keyed by the node whose body scopes them.
  const scopes: Array<{ scope: ts.Node; names: Set<string> }> = [];
  const findSeeds = (n: ts.Node): void => {
    if (ts.isCatchClause(n) && n.variableDeclaration) {
      scopes.push({ scope: n.block, names: new Set(bindingNames(n.variableDeclaration.name)) });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
      const method = n.expression.name.text;
      const handler = method === 'catch' ? n.arguments[0] : method === 'then' ? n.arguments[1] : undefined;
      if (handler && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))) {
        const first = handler.parameters[0];
        if (first) scopes.push({ scope: handler, names: new Set(bindingNames(first.name)) });
      }
    }
    ts.forEachChild(n, findSeeds);
  };
  findSeeds(sf);

  const findings: UnformattedErrorText[] = [];
  for (const { scope, names } of scopes) {
    // Bare aliases (`const e = err`, `last = err`) carry the caught value.
    for (let changed = true; changed; ) {
      changed = false;
      const walk = (n: ts.Node): void => {
        let target: string[] = [];
        let value: ts.Expression | undefined;
        if (ts.isVariableDeclaration(n) && n.initializer) {
          target = bindingNames(n.name);
          value = n.initializer;
        } else if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left)
        ) {
          target = [n.left.text];
          value = n.right;
        }
        if (value) {
          const v = unwrap(value);
          if (ts.isIdentifier(v) && names.has(v.text)) {
            for (const t of target) {
              if (!names.has(t)) {
                names.add(t);
                changed = true;
              }
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      ts.forEachChild(scope, walk);
    }

    const check = (n: ts.Node): void => {
      if (ts.isIdentifier(n) && names.has(n.text)) {
        const p = n.parent;
        const isName =
          (ts.isPropertyAccessExpression(p) && p.name === n) ||
          (ts.isPropertyAssignment(p) && p.name === n) ||
          (ts.isVariableDeclaration(p) && p.name === n) ||
          ts.isParameter(p) ||
          ts.isBindingElement(p);
        if (!isName) {
          const hit = textForm(n);
          if (hit && !insideFormatter(n, scope) && !onlyTested(hit.at)) {
            findings.push({
              line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
              name: n.text,
              form: hit.form,
              text: hit.at.getText(sf).split('\n')[0]!.slice(0, 120),
              start: n.getStart(sf),
              end: n.getEnd(),
            });
          }
        }
      }
      ts.forEachChild(n, check);
    };
    ts.forEachChild(scope, check);
  }

  const seen = new Set<string>();
  return findings
    .filter((f) => {
      const k = `${f.line}:${f.name}:${f.form}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}
