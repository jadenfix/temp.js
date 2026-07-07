// Minimal deterministic assert shim for server-side package compatibility.
// It depends only on local values and util formatting: no process state, host
// inspection, warnings, or async resources are created behind the caller's back.

import { inspect, isDeepStrictEqual } from "node:util";

function defaultMessage(actual, expected, operator) {
  if (operator === "ok") return `Expected value to be truthy: ${inspect(actual)}`;
  if (operator === "fail") return "Failed";
  return `${inspect(actual)} ${operator} ${inspect(expected)}`;
}

export class AssertionError extends Error {
  constructor(options = {}) {
    const generatedMessage = options.message === undefined;
    super(generatedMessage ? defaultMessage(options.actual, options.expected, options.operator ?? "fail") : String(options.message));
    this.name = "AssertionError";
    this.code = "ERR_ASSERTION";
    this.actual = options.actual;
    this.expected = options.expected;
    this.operator = options.operator ?? "fail";
    this.generatedMessage = generatedMessage;
  }
}

function assertionFailure(actual, expected, message, operator) {
  throw new AssertionError({ actual, expected, message, operator });
}

function normalizeExpected(expected, message) {
  if (typeof expected === "string" && message === undefined) {
    return [undefined, expected];
  }
  return [expected, message];
}

function regexMatches(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function assertString(value, name) {
  if (typeof value !== "string") {
    throw new TypeError(`assert.${name} requires a string input`);
  }
}

function isErrorConstructor(value) {
  return value === Error || (typeof value === "function" && value.prototype instanceof Error);
}

function expectedException(actual, expected) {
  if (expected === undefined || expected === null) return true;
  if (expected instanceof RegExp) {
    return regexMatches(expected, String(actual?.message ?? actual));
  }
  if (typeof expected === "function") {
    if (isErrorConstructor(expected)) return actual instanceof expected;
    return expected(actual) === true;
  }
  if (typeof expected === "object") {
    for (const key of Object.keys(expected)) {
      const expectedValue = expected[key];
      const actualValue = actual?.[key];
      if (expectedValue instanceof RegExp) {
        if (!regexMatches(expectedValue, String(actualValue))) return false;
      } else if (!isDeepStrictEqual(actualValue, expectedValue)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function assert(value, message = undefined) {
  return ok(value, message);
}

export function ok(value, message = undefined) {
  if (!value) assertionFailure(value, true, message, "ok");
}

export function fail(actual = undefined, expected = undefined, message = undefined, operator = "fail") {
  if (arguments.length <= 1) {
    assertionFailure(undefined, undefined, actual, "fail");
  }
  assertionFailure(actual, expected, message, operator);
}

export function equal(actual, expected, message = undefined) {
  // Deliberately loose for Node assert.equal compatibility.
  // eslint-disable-next-line eqeqeq
  if (actual != expected) assertionFailure(actual, expected, message, "equal");
}

export function notEqual(actual, expected, message = undefined) {
  // Deliberately loose for Node assert.notEqual compatibility.
  // eslint-disable-next-line eqeqeq
  if (actual == expected) assertionFailure(actual, expected, message, "notEqual");
}

export function strictEqual(actual, expected, message = undefined) {
  if (!Object.is(actual, expected)) assertionFailure(actual, expected, message, "strictEqual");
}

export function notStrictEqual(actual, expected, message = undefined) {
  if (Object.is(actual, expected)) assertionFailure(actual, expected, message, "notStrictEqual");
}

export function deepStrictEqual(actual, expected, message = undefined) {
  if (!isDeepStrictEqual(actual, expected)) assertionFailure(actual, expected, message, "deepStrictEqual");
}

export function notDeepStrictEqual(actual, expected, message = undefined) {
  if (isDeepStrictEqual(actual, expected)) assertionFailure(actual, expected, message, "notDeepStrictEqual");
}

function looseDeepEqual(actual, expected, seen = new Map()) {
  if (Object.is(actual, expected)) return true;
  // Deliberately loose for legacy node:assert.deepEqual compatibility.
  // eslint-disable-next-line eqeqeq
  if (actual == expected) return true;
  if (typeof actual !== "object" || actual === null || typeof expected !== "object" || expected === null) {
    return false;
  }
  if (seen.get(actual) === expected) return true;
  seen.set(actual, expected);
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  if (actual instanceof RegExp && expected instanceof RegExp) {
    return actual.source === expected.source && actual.flags === expected.flags;
  }
  if (actual instanceof ArrayBuffer || ArrayBuffer.isView(actual)) return isDeepStrictEqual(actual, expected);
  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected) || actual.length !== expected.length) return false;
    for (let index = 0; index < actual.length; index += 1) {
      if (!looseDeepEqual(actual[index], expected[index], seen)) return false;
    }
    return true;
  }
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let index = 0; index < actualKeys.length; index += 1) {
    if (actualKeys[index] !== expectedKeys[index]) return false;
    if (!looseDeepEqual(actual[actualKeys[index]], expected[actualKeys[index]], seen)) return false;
  }
  return true;
}

export function deepEqual(actual, expected, message = undefined) {
  if (!looseDeepEqual(actual, expected)) assertionFailure(actual, expected, message, "deepEqual");
}

export function notDeepEqual(actual, expected, message = undefined) {
  if (looseDeepEqual(actual, expected)) assertionFailure(actual, expected, message, "notDeepEqual");
}

export function match(value, regexp, message = undefined) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.match requires a RegExp");
  assertString(value, "match");
  if (!regexMatches(regexp, value)) assertionFailure(value, regexp, message, "match");
}

export function doesNotMatch(value, regexp, message = undefined) {
  if (!(regexp instanceof RegExp)) throw new TypeError("assert.doesNotMatch requires a RegExp");
  assertString(value, "doesNotMatch");
  if (regexMatches(regexp, value)) assertionFailure(value, regexp, message, "doesNotMatch");
}

export function throws(block, expected = undefined, message = undefined) {
  if (typeof block !== "function") throw new TypeError("assert.throws requires a function");
  [expected, message] = normalizeExpected(expected, message);
  let actual;
  try {
    block();
  } catch (error) {
    actual = error;
  }
  if (actual === undefined) assertionFailure(undefined, expected, message, "throws");
  if (!expectedException(actual, expected)) assertionFailure(actual, expected, message, "throws");
  return actual;
}

export function doesNotThrow(block, expected = undefined, message = undefined) {
  if (typeof block !== "function") throw new TypeError("assert.doesNotThrow requires a function");
  [expected, message] = normalizeExpected(expected, message);
  try {
    block();
  } catch (error) {
    if (expectedException(error, expected)) {
      assertionFailure(error, expected, message, "doesNotThrow");
    }
    throw error;
  }
}

function promiseFrom(value) {
  return typeof value === "function" ? value() : value;
}

export async function rejects(value, expected = undefined, message = undefined) {
  [expected, message] = normalizeExpected(expected, message);
  try {
    await promiseFrom(value);
  } catch (error) {
    if (!expectedException(error, expected)) assertionFailure(error, expected, message, "rejects");
    return error;
  }
  assertionFailure(undefined, expected, message, "rejects");
}

export async function doesNotReject(value, expected = undefined, message = undefined) {
  [expected, message] = normalizeExpected(expected, message);
  try {
    await promiseFrom(value);
  } catch (error) {
    if (expectedException(error, expected)) {
      assertionFailure(error, expected, message, "doesNotReject");
    }
    throw error;
  }
}

export function ifError(error) {
  if (error !== null && error !== undefined) {
    const suffix = error?.message ? `: ${error.message}` : `: ${inspect(error)}`;
    assertionFailure(error, null, `ifError got unwanted exception${suffix}`, "ifError");
  }
}

function strictAssert(value, message = undefined) {
  return ok(value, message);
}

const strict = strictAssert;

Object.assign(assert, {
  AssertionError,
  deepEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal,
  fail,
  ifError,
  match,
  notDeepEqual,
  notDeepStrictEqual,
  notEqual,
  notStrictEqual,
  ok,
  rejects,
  strict,
  strictEqual,
  throws,
});

Object.assign(strictAssert, {
  AssertionError,
  deepEqual: deepStrictEqual,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  equal: strictEqual,
  fail,
  ifError,
  match,
  notDeepEqual: notDeepStrictEqual,
  notDeepStrictEqual,
  notEqual: notStrictEqual,
  notStrictEqual,
  ok,
  rejects,
  strict,
  strictEqual,
  throws,
});

export { assert, strict };
export default assert;
