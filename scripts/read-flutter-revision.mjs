import { appendFile, readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(new URL("../sdk-compatibility.json", import.meta.url), "utf8"));
if (config.schemaVersion !== 1 ||
    config.flutter?.repository !== "https://github.com/c0x65o/handrail-sdk-chat-flutter.git" ||
    !/^[a-f0-9]{40}$/.test(config.flutter?.revision ?? "")) {
  throw new Error("sdk-compatibility.json requires the full committed Flutter SDK SHA. The scaffold revision is not an SDK revision; finish the authorized commit/push before enabling the paired CI gate.");
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `revision=${config.flutter.revision}\n`);
} else {
  console.log(config.flutter.revision);
}
