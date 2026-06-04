import { config } from "./src/config.js";
import { ensureTikTokAccessToken } from "./src/tiktok.js";

async function main() {
  const publishId = process.argv[2] || "p_pub_url~v2.7647387537161439250";
  console.log("Checking status for publishId:", publishId);

  const accessToken = await ensureTikTokAccessToken();
  console.log("Access token resolved.");

  const response = await fetch("https://open.tiktokapis.com/v2/post/publish/status/fetch/", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8"
    },
    body: JSON.stringify({
      publish_id: publishId
    })
  });

  const data = await response.json();
  console.log("Response:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
