import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "bun:test";

import {
  ensureDirectorySymlink,
  ensureWorkspaceNodeModules,
} from "../src/build/resolve/workspace.ts";
import { createFixture } from "./helpers.mjs";

test("workspace symlink setup is concurrency-safe", async () => {
  const fixture = await createFixture();
  const targetPath = path.join(fixture.projectRoot, "target");
  const linkPath = path.join(fixture.projectRoot, "workspace", "src");
  await fs.mkdir(targetPath, { recursive: true });

  await Promise.all(
    Array.from({ length: 32 }, () =>
      ensureDirectorySymlink(linkPath, targetPath),
    ),
  );

  const currentTarget = await fs.readlink(linkPath);
  expect(path.resolve(path.dirname(linkPath), currentTarget)).toBe(targetPath);
});

test("workspace node_modules uses the nearest project ancestor", async () => {
  const fixture = await createFixture();
  const projectRoot = path.join(fixture.projectRoot, "packages", "app");
  const nearestNodeModules = path.join(
    fixture.projectRoot,
    "packages",
    "node_modules",
  );
  const workspaceDir = path.join(fixture.projectRoot, "workspace");
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(nearestNodeModules, { recursive: true });
  await fs.mkdir(path.join(fixture.projectRoot, "node_modules"), {
    recursive: true,
  });

  await ensureWorkspaceNodeModules(workspaceDir, {
    packages: "esm-only",
    projectRoot,
  });

  const linkPath = path.join(workspaceDir, "node_modules");
  const currentTarget = await fs.readlink(linkPath);
  expect(path.resolve(path.dirname(linkPath), currentTarget)).toBe(
    nearestNodeModules,
  );
});
