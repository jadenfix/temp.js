// Strict assertion entrypoint layered over the deterministic assert shim.

import {
  AssertionError,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  fail,
  ifError,
  match,
  notDeepStrictEqual,
  notStrictEqual,
  ok,
  rejects,
  strict as strictAssert,
  strictEqual,
  throws,
} from "node:assert";

export {
  AssertionError,
  deepStrictEqual,
  doesNotMatch,
  doesNotReject,
  doesNotThrow,
  fail,
  ifError,
  match,
  notDeepStrictEqual,
  notStrictEqual,
  ok,
  rejects,
  strictEqual,
  throws,
};

export const deepEqual = deepStrictEqual;
export const notDeepEqual = notDeepStrictEqual;
export const equal = strictEqual;
export const notEqual = notStrictEqual;
export const strict = strictAssert;

export default strictAssert;
