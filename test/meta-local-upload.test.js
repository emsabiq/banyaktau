import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Facebook and Instagram can upload the runner video directly", async () => {
  process.env.FACEBOOK_UPLOAD_ENABLED = "true";
  process.env.BANYAKTAU_FACEBOOK_PAGE_ID = "page-123";
  process.env.BANYAKTAU_FACEBOOK_PAGE_ACCESS_TOKEN = "facebook-token";
  process.env.FACEBOOK_PAGE_ID = "page-123";
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = "facebook-token";
  process.env.FACEBOOK_MEDIA_TYPE = "reel";
  process.env.INSTAGRAM_UPLOAD_ENABLED = "true";
  process.env.BANYAKTAU_INSTAGRAM_IG_USER_ID = "ig-123";
  process.env.BANYAKTAU_INSTAGRAM_ACCESS_TOKEN = "instagram-token";
  process.env.INSTAGRAM_IG_USER_ID = "ig-123";
  process.env.INSTAGRAM_ACCESS_TOKEN = "instagram-token";
  process.env.INSTAGRAM_CONTAINER_POLL_SECONDS = "0";

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "banyaktau-meta-upload-"));
  const videoPath = path.join(tempDir, "video.mp4");
  const videoBytes = Buffer.from("fake-mp4-content");
  await fs.writeFile(videoPath, videoBytes);

  const uploads = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = String(input);
    if (url.includes("/me?")) return jsonResponse({ id: "page-123", name: "BanyakTau" });
    if (url.includes("/page-123/video_reels") && url.includes("upload_phase=start")) {
      return jsonResponse({ video_id: "fb-video", upload_url: "https://upload.test/facebook" });
    }
    if (url === "https://upload.test/facebook") {
      uploads.push({ platform: "facebook", options });
      return jsonResponse({ success: true });
    }
    if (url.includes("/page-123/video_reels") && url.includes("upload_phase=finish")) {
      return jsonResponse({ success: true, post_id: "fb-post" });
    }
    if (url.endsWith("/ig-123/media")) {
      return jsonResponse({ id: "ig-container", uri: "https://upload.test/instagram" });
    }
    if (url === "https://upload.test/instagram") {
      uploads.push({ platform: "instagram", options });
      return jsonResponse({ success: true });
    }
    if (url.includes("/ig-container?")) {
      return jsonResponse({ id: "ig-container", status_code: "FINISHED" });
    }
    if (url.endsWith("/ig-123/media_publish")) return jsonResponse({ id: "ig-media" });
    if (url.includes("/ig-media?")) return jsonResponse({ permalink: "https://instagram.test/reel/ig-media" });
    throw new Error(`Unexpected fetch: ${url}`);
  };

  try {
    const { publishToFacebook, publishToInstagram } = await import("../src/facebook.js");
    const facebook = await publishToFacebook({ videoPath, title: "Test", description: "Test" });
    const instagram = await publishToInstagram({ videoPath, title: "Test", description: "Test", durationSec: 30 });

    assert.equal(facebook.videoId, "fb-video");
    assert.equal(instagram.mediaId, "ig-media");
    assert.deepEqual(uploads.map((entry) => entry.platform), ["facebook", "instagram"]);
    for (const upload of uploads) {
      assert.equal(upload.options.headers.offset, "0");
      assert.equal(upload.options.headers.file_size, String(videoBytes.length));
      assert.deepEqual(Buffer.from(upload.options.body), videoBytes);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
