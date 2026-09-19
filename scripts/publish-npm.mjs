import { rm } from "node:fs/promises";
import { prepareRelease, assertPreparedArtifact } from "./prepare-release.mjs";
import { runNpm } from "./npm-command.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--dry-run")) {
  throw new Error(
    "Usage: publish-npm.mjs [--dry-run]; arbitrary npm options and unverified paths are not accepted",
  );
}
const prepared = await prepareRelease({ allNative: true });
try {
  // Check the complete set before the first upload; publication itself cannot be transactional.
  for (const artifact of prepared.artifacts)
    await assertPreparedArtifact(artifact);
  for (const artifact of prepared.artifacts) {
    await assertPreparedArtifact(artifact);
    const { stdout, stderr } = await runNpm(
      [
        "publish",
        artifact.path,
        "--ignore-scripts",
        "--access",
        "public",
        ...args,
      ],
      prepared.directory,
    );
    process.stdout.write(stdout);
    process.stderr.write(stderr);
  }
} finally {
  await rm(prepared.directory, { force: true, recursive: true });
}
