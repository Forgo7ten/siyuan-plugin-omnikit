import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const dockPath = new URL("../../src/features/image-compressor/ui/ImageRecordsDock.svelte", import.meta.url);
const cardPath = new URL("../../src/features/image-compressor/ui/ImageRecordCard.svelte", import.meta.url);
const refsPath = new URL("../../src/features/image-compressor/ui/ImageRecordReferences.svelte", import.meta.url);

test("ImageRecordsDock status badges use native theme CSS variables without hardcoded hex or rgba colors", async () => {
  const [dock, card, refs] = await Promise.all([
    readFile(dockPath, "utf8"),
    readFile(cardPath, "utf8"),
    readFile(refsPath, "utf8"),
  ]);
  const combined = [dock, card, refs].join("\n");

  // Verify no hardcoded hex badge colors across all Dock UI components
  assert.doesNotMatch(combined, /#388e3c/);
  assert.doesNotMatch(combined, /#d32f2f/);
  assert.doesNotMatch(combined, /#1976d2/);

  // Extract the badge styles block from ImageRecordCard.svelte
  const badgeSection = card.slice(card.indexOf(".image-records__badge"), card.indexOf(".image-records__spinner"));
  assert.ok(badgeSection.length > 0, "Badge section should be present");

  // Verify badge styles do not contain any hex color (#...) or rgba(...)
  assert.doesNotMatch(badgeSection, /#[0-9a-fA-F]{3,8}/);
  assert.doesNotMatch(badgeSection, /rgba\(/);

  // Verify theme variable integration
  assert.match(badgeSection, /--b3-theme-primary/);
  assert.match(badgeSection, /--b3-theme-error/);
  assert.match(badgeSection, /--b3-theme-secondary/);

  // Verify exact rule definitions
  assert.match(
    badgeSection,
    /\.image-records__badge--present\s*\{\s*background:\s*color-mix\(in srgb, var\(--b3-theme-primary\) 12%, transparent\);\s*color:\s*var\(--b3-theme-primary\);\s*\}/,
  );
  assert.match(
    badgeSection,
    /\.image-records__badge--missing\s*\{\s*background:\s*color-mix\(in srgb, var\(--b3-theme-error\) 12%, transparent\);\s*color:\s*var\(--b3-theme-error\);\s*\}/,
  );
  assert.match(
    badgeSection,
    /\.image-records__badge--checking\s*\{\s*background:\s*color-mix\(in srgb, var\(--b3-theme-secondary\) 12%, transparent\);\s*color:\s*var\(--b3-theme-secondary\);\s*\}/,
  );
});
