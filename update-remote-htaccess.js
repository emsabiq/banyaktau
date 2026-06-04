import SftpClient from "ssh2-sftp-client";

async function main() {
  const client = new SftpClient();
  const config = {
    host: "153.92.9.168",
    port: 65002,
    username: "u940617512",
    password: "1JAM47menit!"
  };
  
  console.log("Connecting to SFTP...");
  await client.connect(config);
  console.log("Connected!");

  const remotePath = "/home/u940617512/domains/emsa.pro/public_html/.htaccess";
  console.log("Reading remote .htaccess...");
  let content = "";
  try {
    const data = await client.get(remotePath);
    content = data.toString("utf8");
    console.log("Current content:\n", content);
  } catch (err) {
    console.log("File not found, creating new one.");
  }

  // Define new block to add or overwrite
  const customBlock = `
# ===================================================
# BYPASS SECURITY & WAF FOR BANYAKTAU (TIKTOK BOT)
# ===================================================
<IfModule mod_security.c>
    SecRuleEngine Off
    SecFilterEngine Off
    SecFilterScanPOST Off
</IfModule>

<IfModule mod_env.c>
    SetEnvIf User-Agent ".*(TikTok|Byte).* " disable-waf
</IfModule>
# ===================================================
`;

  // We want to append or replace the ModSecurity section
  let newContent = content;
  
  // Clean up any old ModSecurity section
  newContent = newContent.replace(/<IfModule mod_security\.c>[\s\S]*?<\/IfModule>/gi, "");
  newContent = newContent.replace(/# Izinkan bot luar[\s\S]*$/gi, "");
  
  // Append new custom block
  newContent = newContent.trim() + "\n" + customBlock.trim() + "\n";
  
  console.log("Writing updated .htaccess content:\n", newContent);
  await client.put(Buffer.from(newContent, "utf8"), remotePath);
  console.log("Updated .htaccess successfully!");
  
  await client.end();
}

main().catch(console.error);
