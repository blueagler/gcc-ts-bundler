import { expect, test } from "bun:test";

import { buildCargoEnvironment } from "../scripts/build-native.mjs";

const MUSL_ZIGBUILD_RUSTFLAG = "-C target-feature=-crt-static";

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
    expect(environment.RUSTFLAGS.split(MUSL_ZIGBUILD_RUSTFLAG)).toHaveLength(2);
  }
});

test("only musl zigbuild builds receive the dynamic CRT flag", () => {
  for (const target of [
    { cargoCommand: "zigbuild", libc: "gnu" },
    { cargoCommand: "zigbuild", libc: null },
    { cargoCommand: "build", libc: "musl" },
  ]) {
    const input = { RUSTFLAGS: "-C debuginfo=1" };
    expect(buildCargoEnvironment({ ...target, environment: input })).toBe(
      input,
    );
  }
});
