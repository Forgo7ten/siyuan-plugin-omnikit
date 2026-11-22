import { test } from "node:test";
import assert from "node:assert/strict";
import { TitleCache } from "../../../src/features/titled-link/services/title-cache.ts";

test("title cache expires entries after its TTL", () => {
  let now = 100;
  const cache = new TitleCache({ ttlMs: 50, now: () => now });
  const generation = cache.captureGeneration("https://example.com");
  assert.equal(cache.set("https://example.com", "Example", generation), true);
  assert.equal(cache.get("https://example.com"), "Example");
  now = 150;
  assert.equal(cache.get("https://example.com"), undefined);
  assert.equal(cache.size, 0);
});

test("title cache evicts the least recently used entry", () => {
  const cache = new TitleCache({ capacity: 2 });
  const generation = cache.captureGeneration("a");
  cache.set("a", "A", generation);
  cache.set("b", "B", generation);
  assert.equal(cache.get("a"), "A");
  cache.set("c", "C", generation);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), "A");
  assert.equal(cache.get("c"), "C");
});

test("manual refresh prevents stale in-flight responses from polluting the cache", () => {
  const cache = new TitleCache();
  const staleGeneration = cache.captureGeneration("https://example.com");
  const refreshedGeneration = cache.refresh("https://example.com", "Newest");
  assert.ok(refreshedGeneration > staleGeneration);
  assert.equal(cache.set("https://example.com", "Old response", staleGeneration), false);
  assert.equal(cache.get("https://example.com"), "Newest");
});

test("clearing the cache also invalidates outstanding generations", () => {
  const cache = new TitleCache();
  const generation = cache.captureGeneration("https://example.com");
  cache.clear();
  assert.equal(cache.set("https://example.com", "Late", generation), false);
  assert.equal(cache.size, 0);
});

test("advances generations per url instead of globally", () => {
  const cache = new TitleCache();
  const genA = cache.captureGeneration("https://a.example");
  const genB = cache.captureGeneration("https://b.example");
  cache.refresh("https://a.example", "Fresh A");
  assert.equal(cache.set("https://a.example", "Stale A", genA), false);
  assert.equal(cache.set("https://b.example", "Title B", genB), true);
  assert.equal(cache.get("https://a.example"), "Fresh A");
  assert.equal(cache.get("https://b.example"), "Title B");
});
