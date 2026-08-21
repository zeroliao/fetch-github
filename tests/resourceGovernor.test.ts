import assert from "node:assert/strict";
import test from "node:test";
import { calculateDynamicBatchSize } from "../src/server/resourceGovernor";

test("memory governor pauses at the configured floor", () => {
  assert.equal(calculateDynamicBatchSize(512, 512, "llm"), 0);
  assert.equal(calculateDynamicBatchSize(400, 512, "document"), 0);
});

test("memory governor grows stage batches with available headroom", () => {
  assert.equal(calculateDynamicBatchSize(513, 512, "llm"), 1);
  assert.equal(calculateDynamicBatchSize(768, 512, "llm"), 2);
  assert.equal(calculateDynamicBatchSize(4096, 512, "llm"), 4);
  assert.equal(calculateDynamicBatchSize(4096, 512, "profile"), 64);
});
