import { startEmbeddedFixtureHost } from "./host.js";

const host = await startEmbeddedFixtureHost();
console.log(`Embedded fixture host listening at ${host.origin}`);

let shuttingDown = false;
const shutdown = (): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  void host.close().then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
};

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
