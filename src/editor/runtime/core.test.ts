import test from "node:test";
import assert from "node:assert/strict";
import { createRng, shuffledSliceOrderWithLocks } from "./core.js";

test("shuffledSliceOrderWithLocks preserves locked step values", () => {
  const current = [1, 5, 5, 3, 1, 6, 5, 3, 1, 5, 5, 7, 1, 6, 5, 3];
  const locked = [true, false, false, true, true, false, false, true, true, false, false, false, true, false, false, true];
  const out = shuffledSliceOrderWithLocks(createRng(1234), current, locked, 16, 16);

  locked.forEach((isLocked, index) => {
    if (isLocked) assert.equal(out[index], current[index]);
  });
  assert.equal(out.length, 16);
});
