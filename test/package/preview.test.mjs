import { expect, onTestFinished, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "gcc-preview-contract-"),
  );
  onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "scripts"));
  const script = path.join(root, "scripts/preview-example.mjs");
  await fs.copyFile(
    new URL("../../scripts/preview-example.mjs", import.meta.url),
    script,
  );
  for (const name of ["app", "react-a", "react-b"]) {
    const directory = path.join(root, "examples", name);
    await fs.mkdir(path.join(directory, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(directory, "dist/index.html"),
      "prepared preview",
    );
    await fs.writeFile(path.join(directory, "package.json"), "{}");
  }
  const vite = path.join(root, "node_modules/vite");
  await fs.mkdir(vite, { recursive: true });
  await fs.writeFile(
    path.join(vite, "package.json"),
    JSON.stringify({ name: "vite", type: "module", bin: { vite: "cli.mjs" } }),
  );
  await fs.writeFile(
    path.join(vite, "cli.mjs"),
    `
import http from "node:http";
import fs from "node:fs";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
const host = args[args.indexOf("--host") + 1];
fs.writeFileSync(${JSON.stringify(path.join(root, "child-started"))}, "started");
const server = http.createServer((request, response) => response.end("prepared preview"));
server.on("error", (error) => {
  if (error.code === "EADDRINUSE" && !args.includes("--strictPort")) server.listen(0, host);
  else process.exit(7);
});
server.listen(port, host, () => console.log(JSON.stringify(server.address())));
`,
  );
  const sentinel = path.join(root, "sentinel.mjs");
  await fs.writeFile(
    sentinel,
    `
import http from "node:http";
const server = http.createServer((request, response) => response.end("unrelated process"));
server.listen(0, "127.0.0.1", () => console.log(JSON.stringify(server.address())));
`,
  );
  return { root, script, sentinel };
}

async function start(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await done;
  });
  const ready = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
      if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]));
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("Preview exited before listening")),
    );
  });
  return { child, done, ready };
}

test("busy preview port fails with the child status and leaves an unrelated listener alive", async () => {
  const { script, sentinel } = await fixture();
  const unrelated = await start(sentinel);
  const result = spawnSync(
    process.execPath,
    [script, "app", "--port", String(unrelated.ready.port)],
    { encoding: "utf8", timeout: 5000 },
  );
  expect(result.status, result.stderr).toBe(7);
  expect(
    await (await fetch(`http://127.0.0.1:${unrelated.ready.port}`)).text(),
  ).toBe("unrelated process");
  expect(unrelated.child.exitCode).toBeNull();
});

test("preview binds loopback and forwards interruption only to its owned child", async () => {
  const { script, sentinel } = await fixture();
  const unrelated = await start(sentinel);
  // Reserve then release a separate port; strict-port makes any race a failure, never an eviction.
  const reservation = await start(sentinel);
  reservation.child.kill("SIGTERM");
  await reservation.done;
  const preview = await start(script, [
    "app",
    "--port",
    String(reservation.ready.port),
  ]);
  expect(preview.ready.address).toBe("127.0.0.1");
  expect(
    await (await fetch(`http://127.0.0.1:${preview.ready.port}`)).text(),
  ).toBe("prepared preview");
  preview.child.kill("SIGTERM");
  expect((await preview.done).signal).toBe("SIGTERM");
  expect(
    await (await fetch(`http://127.0.0.1:${unrelated.ready.port}`)).text(),
  ).toBe("unrelated process");
});

test("invalid or ambiguous preview selection starts no child", async () => {
  const { root, script } = await fixture();
  for (const args of [
    [],
    ["react"],
    ["missing"],
    ["app", "--port", "0"],
    ["app", "--port", "1.5"],
    ["app", "--port", "65536"],
    ["app", "--host"],
    ["app", "--port=4173", "--port=4174"],
    ["app", "--unknown"],
  ]) {
    expect(
      spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })
        .status,
    ).not.toBe(0);
  }
  expect(
    await fs.stat(path.join(root, "child-started")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
