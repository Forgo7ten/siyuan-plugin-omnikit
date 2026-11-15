import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImageCandidate } from "../../../src/features/image-compressor/policy/ImageCandidateClassifier.ts";

const excluded = ["gif", "svg", "webp"];

test("classifyImageCandidate permits normal png and jpeg images", () => {
  const png = classifyImageCandidate({
    path: "assets/photo.png",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(png.eligible, true);
  assert.equal(png.extension, "png");

  const jpg = classifyImageCandidate({
    path: "assets/nested/sub/scenery.jpeg",
    mode: "document",
    excludedExtensions: excluded,
  });
  assert.equal(jpg.eligible, true);
  assert.equal(jpg.extension, "jpeg");
});

test("classifyImageCandidate excludes all specified video extensions", () => {
  const videos = [
    "mp4", "m4v", "mov", "avi", "wmv", "flv", "mkv", "webm", "3gp", "ogv",
    "mpeg", "mpg", "mts", "m2ts", "ts", "vob", "asf", "rm", "rmvb", "f4v",
  ];
  for (const ext of videos) {
    const res = classifyImageCandidate({
      path: `assets/clip.${ext}`,
      mode: "auto",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, false);
    assert.equal(res.reason, "video");
    assert.equal(res.extension, ext);
  }
});

test("classifyImageCandidate protects Excalidraw and drawings paths", () => {
  const samples = [
    "assets/excalidraw-2024.png",
    "assets/my-excalidraw.jpg",
    "drawings/diagram.png",
    "assets/drawings/flow.png",
    "assets/drawings_v2.png",
  ];
  for (const path of samples) {
    const res = classifyImageCandidate({
      path,
      mode: "manual-quick",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, false);
    assert.equal(res.reason, "excalidraw");
  }
});

test("classifyImageCandidate excludes animated (gif, apng) and vector (svg) formats", () => {
  const gif = classifyImageCandidate({ path: "assets/anim.gif", mode: "auto", excludedExtensions: [] });
  assert.equal(gif.eligible, false);
  assert.equal(gif.reason, "animated-format");

  const apng = classifyImageCandidate({ path: "assets/anim.apng", mode: "auto", excludedExtensions: [] });
  assert.equal(apng.eligible, false);
  assert.equal(apng.reason, "animated-format");

  const svg = classifyImageCandidate({ path: "assets/icon.svg", mode: "auto", excludedExtensions: [] });
  assert.equal(svg.eligible, false);
  assert.equal(svg.reason, "vector-format");
});

test("classifyImageCandidate treats WebP differently in auto vs manual-dialog", () => {
  const auto = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(auto.eligible, false);
  assert.equal(auto.reason, "excluded-extension");

  const batch = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "document",
    excludedExtensions: excluded,
  });
  assert.equal(batch.eligible, false);
  assert.equal(batch.reason, "excluded-extension");

  const quick = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "manual-quick",
    excludedExtensions: excluded,
  });
  assert.equal(quick.eligible, false);
  assert.equal(quick.reason, "excluded-extension");

  const dialog = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "manual-dialog",
    excludedExtensions: excluded,
  });
  assert.equal(dialog.eligible, true);
  assert.equal(dialog.extension, "webp");
});

test("classifyImageCandidate normalizes URL query, fragment, and backslashes", () => {
  const urlRes = classifyImageCandidate({
    path: "https://example.com/images/cat.png?token=secret&size=large#section",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(urlRes.eligible, true);
  assert.equal(urlRes.extension, "png");

  const winRes = classifyImageCandidate({
    path: "assets\\subfolder\\dog.jpg?v=1",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(winRes.eligible, true);
  assert.equal(winRes.extension, "jpg");
});
