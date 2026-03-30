import { main } from "../api/build";

void main(process.argv.slice(2)).then((exitCode) => {
  process.exit(exitCode);
});
