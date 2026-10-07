import assert from "node:assert/strict";
import { test } from "node:test";
import { isNonBlankString, isNullableString, isProbability, isRecord } from "../extension/utils.ts";

test("isRecord accepts non-null objects, including errors, without restricting their prototype", () => {
  for (const value of [{}, Object.freeze({ code: "ENOENT" }), Object.create(null), new Error("test")]) {
    assert.equal(isRecord(value), true);
  }
  for (const value of [null, undefined, [], "object", 0, true, () => ({})]) {
    assert.equal(isRecord(value), false);
  }
});

test("isNullableString accepts null or any string but never coerces values", () => {
  for (const value of [null, "", " ", "text"]) assert.equal(isNullableString(value), true);
  for (const value of [undefined, 0, false, [], {}]) assert.equal(isNullableString(value), false);
});

test("isNonBlankString checks content while preserving the original value", () => {
  const original = " \ncommand\t ";
  assert.equal(isNonBlankString(original), true);
  assert.equal(original, " \ncommand\t ");
  for (const value of ["text", "中文", "0"]) assert.equal(isNonBlankString(value), true);
  for (const value of ["", " \t\r\n", "\u00a0", null, undefined, 0, [], {}]) {
    assert.equal(isNonBlankString(value), false);
  }
});

test("isProbability accepts inclusive finite unit-interval values without coercion", () => {
  for (const value of [0, -0, 0.3, 0.5, 0.8, 1]) assert.equal(isProbability(value), true);
  for (const value of [-Number.EPSILON, 1 + Number.EPSILON, NaN, Infinity, -Infinity,
    "0.5", null, undefined, true, [], {}]) {
    assert.equal(isProbability(value), false);
  }
});
