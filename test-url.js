async function main() {
  const url = "https://banyaktau.emsa.pro/banyaktau/carousels/tau_af8bcbde001a-carousel-01-mikroorganisme-rahasia-di-dalam-tanah-kebunmu.jpg";
  console.log("Fetching WWW Hostinger URL:", url);
  const res = await fetch(url);
  console.log("Status:", res.status);
  console.log("Headers:");
  for (const [key, val] of res.headers.entries()) {
    console.log(`  ${key}: ${val}`);
  }
}

main().catch(console.error);
