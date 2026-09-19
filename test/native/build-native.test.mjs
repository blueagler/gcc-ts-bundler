import { expect, onTestFinished, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildCargoEnvironment } from "../../scripts/build-native.mjs";
import {
  nativeTargets,
  parseNativeTargets,
  validateNativePackage,
} from "../../scripts/native-targets.mjs";

const MUSL_ZIGBUILD_RUSTFLAG = "-C target-feature=-crt-static";

test("invalid native requests fail before reaching any toolchain or deleting package paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "gcc-invalid-native-"));
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  await fs.mkdir(path.join(root, "tools"));
  for (const script of ["build-native.mjs", "native-targets.mjs"]) {
    await fs.copyFile(
      new URL(`../../scripts/${script}`, import.meta.url),
      path.join(root, "scripts", script),
    );
  }
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ version: "1.0.0" }),
  );
  const sentinel = path.join(root, "toolchain-used");
  const executable = `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "used");\n`;
  for (const command of ["cargo", "rustup", "ldd"])
    await fs.writeFile(path.join(root, "tools", command), executable, {
      mode: 0o755,
    });
  const protectedDirectory = path.join(root, "preserve");
  await fs.mkdir(protectedDirectory);
  await fs.writeFile(path.join(protectedDirectory, "value"), "original");
  for (const args of [
    ["--targets", "linux-x64-gnu", "--target", "aarch64-apple-darwin"],
    ["--target", "x86_64-apple-darwin", "--platform", "linux"],
    ["--targets", "darwin-arm64", "--libc", "musl"],
    ["--targets", "linux-arm64-gnu", "--arch", "x64"],
    ["--targets", "linux-x64-gnu", "--package-name", "../preserve"],
    ["--platforms", "plan9"],
    ["--targets", "linux-x64-gnu,"],
    ["--all", "--targets", "linux-x64-gnu"],
    ["--targets", "linux-x64-gnu", "--cargo-command", "xwin"],
    ["--targets"],
    ["--unknown"],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/build-native.mjs"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, PATH: path.join(root, "tools") },
      },
    );
    expect(result.status, JSON.stringify(args)).not.toBe(0);
    expect(
      await fs.readFile(path.join(protectedDirectory, "value"), "utf8"),
    ).toBe("original");
    expect(
      await fs.stat(sentinel).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  }
});

test("native package metadata accepts only its selected supported target and declared version", () => {
  for (const target of Object.values(nativeTargets)) {
    const selected = parseNativeTargets([
      "--targets",
      target.key,
      "--target",
      target.targetTriple,
    ]).targets[0];
    const root = { optionalDependencies: { [target.packageName]: "1.2.3" } };
    const manifest = {
      name: target.packageName,
      version: "1.2.3",
      os: [target.platform],
      cpu: [target.arch],
      ...(target.libc
        ? { libc: [target.libc === "gnu" ? "glibc" : target.libc] }
        : {}),
      main: "index.node",
    };
    validateNativePackage(manifest, selected, root);
    for (const changed of [
      { version: "0.0.0" },
      { cpu: ["unsupported"] },
      { name: "../escape" },
      { libc: ["wrong-libc"] },
      { main: "stub.js" },
    ]) {
      expect(() =>
        validateNativePackage({ ...manifest, ...changed }, selected, root),
      ).toThrow();
    }
  }
});

test("musl zigbuild normalizes dynamic CRT flags once", () => {
  for (const [input, expected] of [
    [undefined, MUSL_ZIGBUILD_RUSTFLAG],
    ["", MUSL_ZIGBUILD_RUSTFLAG],
    [
      "-C debuginfo=1 --cfg feature=fast -C opt-level=2",
      "-C debuginfo=1 --cfg feature=fast -C opt-level=2 -C target-feature=-crt-static",
    ],
    [
      "-C target-feature=-crt-static -C debuginfo=1",
      "-C debuginfo=1 -C target-feature=-crt-static",
    ],
    [
      "-Ctarget-feature=-crt-static -C debuginfo=1",
      "-C debuginfo=1 -C target-feature=-crt-static",
    ],
    [
      "-C target-feature=-crt-static -C debuginfo=1 -C target-feature=-crt-static",
      "-C debuginfo=1 -C target-feature=-crt-static",
    ],
    [
      "--codegen target-feature=-crt-static -C debuginfo=1 -Ctarget-feature=-crt-static --codegen=target-feature=-crt-static",
      "-C debuginfo=1 -C target-feature=-crt-static",
    ],
  ]) {
    const environment = buildCargoEnvironment({
      cargoCommand: "zigbuild",
      environment: input === undefined ? {} : { RUSTFLAGS: input },
      libc: "musl",
    });

    expect(environment.RUSTFLAGS).toBe(expected);
  }
});

test("only musl zigbuild builds receive the dynamic CRT flag", () => {
  for (const target of [
    { cargoCommand: "zigbuild", libc: "gnu" },
    { cargoCommand: "zigbuild", libc: null },
    { cargoCommand: "build", libc: "musl" },
  ]) {
    const input = { RUSTFLAGS: "-C debuginfo=1" };
    expect(
      buildCargoEnvironment({ ...target, environment: input }).RUSTFLAGS,
    ).toBe("-C debuginfo=1");
  }
});
