import { runCli } from "./main";

void runCli(process.argv.slice(2)).then((exitCode) => process.exit(exitCode));
