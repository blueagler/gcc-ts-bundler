import { runCommand } from "./command.mjs";

await runCommand(process.execPath, ["./scripts/build-self.mjs"]);
