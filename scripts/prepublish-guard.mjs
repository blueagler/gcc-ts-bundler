console.error(
  "Direct directory publication is disabled. Use bun run publish:npm [--dry-run] to prepare, verify, and publish the exact tarballs.",
);
process.exitCode = 1;
