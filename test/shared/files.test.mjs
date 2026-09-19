import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import { hashFileInput, syncDirectoryEntries } from "../../src/shared/files.ts";
import { hashContent } from "../../src/shared/hash.ts";
import { createFixture } from "../helpers.mjs";

test("file hashes reflect equal-size content changes with restored timestamps", async () => {
  const fixture = await createFixture();
  await fixture.write("input.txt", "before");
  const filePath = path.join(fixture.projectRoot, "input.txt");
  const timestamp = new Date("2025-01-01T00:00:00Z");
  await fs.utimes(filePath, timestamp, timestamp);
  const originalStat = await fs.stat(filePath);
  const originalHash = await hashFileInput(filePath);

  await fixture.write("input.txt", "after!");
  await fs.utimes(filePath, originalStat.atime, originalStat.mtime);

  expect(await hashFileInput(filePath)).not.toBe(originalHash);
  expect(await hashFileInput(filePath)).toBe(hashContent("after!"));
});

test("file input hashing retains decoded UTF-8 text identity", async () => {
  const fixture = await createFixture();
  const filePath = path.join(fixture.projectRoot, "input.txt");
  await fs.writeFile(filePath, new Uint8Array([0xff, 0x61]));

  expect(await hashFileInput(filePath)).toBe(hashContent("\ufffda"));
});

test("staging refuses an expected leaf symlink before modifying any files", async () => {
  const fixture = await createFixture();
  await fixture.write("outside/sentinel.txt", "outside");
  await fixture.write("stage/retained.txt", "existing");
  const rootDir = path.join(fixture.projectRoot, "stage");
  const sentinel = path.join(fixture.projectRoot, "outside/sentinel.txt");
  await fs.symlink(sentinel, path.join(rootDir, "output.txt"));

  await expect(
    syncDirectoryEntries(rootDir, [
      { relativePath: "output.txt", content: "overwritten" },
    ]),
  ).rejects.toThrow();

  expect(await fixture.read("outside/sentinel.txt")).toBe("outside");
  expect(await fixture.read("stage/retained.txt")).toBe("existing");
});

test("staging refuses a symlinked output parent without writing outside", async () => {
  const fixture = await createFixture();
  await fixture.write("outside/sentinel.txt", "outside");
  await fixture.write("stage/retained.txt", "existing");
  const rootDir = path.join(fixture.projectRoot, "stage");
  await fs.symlink(
    path.join(fixture.projectRoot, "outside"),
    path.join(rootDir, "linked"),
  );

  await expect(
    syncDirectoryEntries(rootDir, [
      { relativePath: "linked/sentinel.txt", content: "overwritten" },
    ]),
  ).rejects.toThrow();

  expect(await fixture.read("outside/sentinel.txt")).toBe("outside");
  expect(await fixture.read("stage/retained.txt")).toBe("existing");
});

test("staging permits symlinked ancestors of the caller-selected root", async () => {
  const fixture = await createFixture();
  await fixture.write("real/retained.txt", "outside staging");
  await fs.symlink(
    path.join(fixture.projectRoot, "real"),
    path.join(fixture.projectRoot, "alias"),
  );

  await syncDirectoryEntries(path.join(fixture.projectRoot, "alias/stage"), [
    { relativePath: "nested/output.txt", content: "written" },
  ]);

  expect(await fixture.read("real/stage/nested/output.txt")).toBe("written");
  expect(await fixture.read("real/retained.txt")).toBe("outside staging");
});

test("staging refuses a symlink as the selected root", async () => {
  const fixture = await createFixture();
  await fixture.write("outside/sentinel.txt", "outside");
  const rootDir = path.join(fixture.projectRoot, "stage");
  await fs.symlink(path.join(fixture.projectRoot, "outside"), rootDir);

  await expect(
    syncDirectoryEntries(rootDir, [
      { relativePath: "sentinel.txt", content: "overwritten" },
    ]),
  ).rejects.toThrow();

  expect(await fixture.read("outside/sentinel.txt")).toBe("outside");
});

test("staging removes stale symlinks without traversing their targets", async () => {
  const fixture = await createFixture();
  await fixture.write("outside/sentinel.txt", "outside");
  await fixture.write("stage/stale.txt", "stale");
  const rootDir = path.join(fixture.projectRoot, "stage");
  await fs.symlink(
    path.join(fixture.projectRoot, "outside"),
    path.join(rootDir, "stale-link"),
  );

  await syncDirectoryEntries(rootDir, [
    { relativePath: "output.txt", content: "new" },
  ]);

  expect(await fixture.read("outside/sentinel.txt")).toBe("outside");
  expect(await fs.readdir(rootDir)).toEqual(["output.txt"]);
});

test("staging reconciles file and directory transitions while preserving generated subtrees", async () => {
  const fixture = await createFixture();
  await fixture.write("stage/to-directory", "old file");
  await fixture.write("stage/to-file/stale.txt", "old child");
  await fixture.write("stage/generated/keep.txt", "preserved");
  const rootDir = path.join(fixture.projectRoot, "stage");

  await syncDirectoryEntries(
    rootDir,
    [
      { relativePath: "to-directory/output.txt", content: "new child" },
      { relativePath: "to-file", content: "new file" },
    ],
    { preserve: (relativePath) => relativePath.startsWith("generated/") },
  );

  expect(await fixture.read("stage/to-directory/output.txt")).toBe("new child");
  expect(await fixture.read("stage/to-file")).toBe("new file");
  expect(await fixture.read("stage/generated/keep.txt")).toBe("preserved");
});

test("invalid destination sets are rejected before sweeping existing staging files", async () => {
  const fixture = await createFixture();
  await fixture.write("stage/retained.txt", "existing");
  const rootDir = path.join(fixture.projectRoot, "stage");
  for (const relativePaths of [
    ["../outside.txt"],
    ["."],
    ["same.txt", "nested/../same.txt"],
    ["parent", "parent/child.txt"],
  ]) {
    await expect(
      syncDirectoryEntries(
        rootDir,
        relativePaths.map((relativePath) => ({
          relativePath,
          content: "new",
        })),
      ),
    ).rejects.toThrow();
    expect(await fixture.read("stage/retained.txt")).toBe("existing");
  }
});
