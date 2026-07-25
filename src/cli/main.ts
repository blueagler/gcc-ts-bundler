import { runCli } from "../api/build";

void runCli(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
});
