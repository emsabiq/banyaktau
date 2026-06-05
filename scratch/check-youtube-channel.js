import { getYoutubeAccessToken } from "../src/youtube-publisher.js";

async function main() {
  const token = await getYoutubeAccessToken();
  console.log("Access token resolved. Fetching channel info...");

  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  const data = await response.json();
  console.log("Response:", JSON.stringify(data, null, 2));
}

main().catch(console.error);
