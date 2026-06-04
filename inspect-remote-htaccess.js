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

  try {
    const remotePath = "/home/u940617512/.logs/error_log_emsa_pro";
    const data = await client.get(remotePath);
    const content = data.toString("utf8");
    const lines = content.split("\n");
    console.log(`Total lines: ${lines.length}`);
    console.log("Last 80 lines of error log:\n");
    console.log(lines.slice(-80).join("\n"));
  } catch (err) {
    console.error("Error reading log:", err.message);
  } finally {
    await client.end();
  }
}

main().catch(console.error);
