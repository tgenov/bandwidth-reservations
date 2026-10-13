// Local ESLint rules for the node:test suites (docs/process/engineering.md §4 and §7).
// node:test has no ready plugin, so these two rules are small and local.

const TEST_FNS = new Set(['test', 'it']);
const ASSERT_HELPER = /^(assert|expect|check|run)/;

/** The name of a test registration call (`test`, `it`, `t.test`, `test.only`), or undefined. */
function testCallName(node) {
  const c = node.callee;
  if (c.type === 'Identifier' && TEST_FNS.has(c.name)) return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') {
    if (c.object.type === 'Identifier' && TEST_FNS.has(c.object.name) && c.property.name === 'only') return c.object.name;
    if (TEST_FNS.has(c.property.name) && c.object.type === 'Identifier' && c.object.name !== 'assert') return c.property.name;
  }
  return undefined;
}

/** The test body: the last argument when it is a function. */
function testBody(node) {
  const last = node.arguments.at(-1);
  return last && (last.type === 'ArrowFunctionExpression' || last.type === 'FunctionExpression') ? last : undefined;
}

/** True when the options object has `skip` or `todo` (a test that does not run has nothing to assert). */
function isSkipped(node) {
  return node.arguments.some((a) => a.type === 'ObjectExpression' && a.properties.some(
    (p) => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && (p.key.name === 'skip' || p.key.name === 'todo')));
}

/** The names along a callee chain: `t.assert.equal` gives ['t', 'assert', 'equal']. */
function calleeNames(callee) {
  const names = [];
  let n = callee;
  while (n) {
    if (n.type === 'Identifier') { names.unshift(n.name); break; }
    if (n.type === 'MemberExpression') {
      if (!n.computed && n.property.type === 'Identifier') names.unshift(n.property.name);
      n = n.object;
    } else if (n.type === 'CallExpression') n = n.callee;
    else if (n.type === 'AwaitExpression' || n.type === 'ChainExpression' || n.type === 'TSNonNullExpression') n = n.expression;
    else break;
  }
  return names;
}

function isAssertion(call) {
  const names = calleeNames(call.callee);
  if (names.includes('assert')) return true;
  const last = names.at(-1);
  return last !== undefined && ASSERT_HELPER.test(last);
}

function containsAssertion(root, keys) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.type === 'CallExpression' && isAssertion(n)) return true;
    for (const k of keys[n.type] ?? []) {
      const v = n[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') stack.push(c); }
      else if (v && typeof v.type === 'string') stack.push(v);
    }
  }
  return false;
}

const testAsserts = {
  meta: {
    type: 'problem',
    docs: { description: 'Every test()/it() body calls an assertion (assert, t.assert, or an assert*/expect*/check*/run* helper).' },
    schema: [],
    messages: { none: 'This test asserts nothing. Call assert/t.assert, or a helper named assert*/expect*/check*/run* (engineering.md §4).' },
  },
  create(context) {
    const keys = context.sourceCode.visitorKeys;
    return {
      CallExpression(node) {
        if (!testCallName(node) || isSkipped(node)) return;
        const body = testBody(node);
        if (body && !containsAssertion(body.body, keys)) context.report({ node: node.callee, messageId: 'none' });
      },
    };
  },
};

// A scenario ID (P1-S05, X1-S02), a contract test ID (`C01 …`, or CP-, CC-, CT-, DT-, T-), `should …`, or `measurement:`.
const TITLE = /^(?:[PX]\d-S\d+|C\d\d |(?:CP|CC|CT|DT|T)-|should |measurement:)/;

/** The static start of a title: a string literal, or a template literal's first part. */
function titleStart(arg) {
  if (!arg) return undefined;
  if (arg.type === 'Literal' && typeof arg.value === 'string') return arg.value;
  if (arg.type === 'TemplateLiteral') return arg.quasis[0]?.value.cooked ?? undefined;
  return undefined;
}

const testName = {
  meta: {
    type: 'suggestion',
    docs: { description: 'A top-level test title starts with a scenario ID, a contract test ID, `should` or `measurement:` (engineering.md §7).' },
    schema: [],
    messages: { bad: 'Test title must start with a scenario ID (P1-S05), a contract test ID (C01 …, CP-, CC-, CT-, DT-, T-), "should" or "measurement:".' },
  },
  create(context) {
    let depth = 0;
    const enter = (node) => { if (testCallName(node)) depth++; };
    const exit = (node) => { if (testCallName(node)) depth--; };
    return {
      CallExpression(node) {
        if (testCallName(node) && depth === 0) {
          const start = titleStart(node.arguments[0]);
          // A title built from a variable (a table-driven test) cannot be checked here.
          if (start !== undefined && !(node.arguments[0].type === 'TemplateLiteral' && start === '') && !TITLE.test(start)) {
            context.report({ node: node.arguments[0], messageId: 'bad' });
          }
        }
        enter(node);
      },
      'CallExpression:exit': exit,
    };
  },
};

export default {
  meta: { name: 'local' },
  rules: { 'test-asserts': testAsserts, 'test-name': testName },
};
