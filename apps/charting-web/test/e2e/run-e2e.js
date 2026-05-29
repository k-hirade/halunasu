import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const testDir = path.join(repoRoot, "apps/charting-web/test/e2e");

async function main() {
  const port = Number(process.env.WEB_E2E_PORT || await findOpenPort(3100));
  const baseUrl = `http://127.0.0.1:${port}`;
  const devServer = startDevServer(port);

  try {
    await waitForServer(baseUrl, devServer);
    const files = (await readdir(testDir))
      .filter((file) => file.endsWith(".test.js"))
      .sort()
      .map((file) => path.join(testDir, file));

    if (!files.length) {
      throw new Error("No E2E test files found.");
    }

    const status = await runNodeTests(files, baseUrl);
    process.exitCode = status;
  } finally {
    await stopProcessGroup(devServer);
  }
}

function startDevServer(port) {
  const child = spawn("npm", [
    "run",
    "dev",
    "--workspace",
    "@halunasu/charting-web",
    "--",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port)
  ], {
    cwd: repoRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      GATEWAY_BASE_URL: "http://127.0.0.1:8081",
      NEXT_PUBLIC_GATEWAY_BASE_URL: "http://127.0.0.1:8081",
      NEXT_TELEMETRY_DISABLED: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(`[web] ${chunk}`));
  child.stderr.on("data", (chunk) => process.stderr.write(`[web] ${chunk}`));
  return child;
}

async function runNodeTests(files, baseUrl) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...files], {
      cwd: repoRoot,
      env: {
        ...process.env,
        WEB_E2E_BASE_URL: baseUrl,
        NEXT_TELEMETRY_DISABLED: "1"
      },
      stdio: "inherit"
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
}

async function waitForServer(baseUrl, child, timeoutMs = 60_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(`Web dev server exited early with status ${child.exitCode}.`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.status < 500) {
        return;
      }
    } catch {
      // keep polling until Next finishes booting
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for ${baseUrl}`);
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 100; port += 1) {
    if (await isPortOpen(port)) {
      return port;
    }
  }

  throw new Error(`No open port found from ${startPort}.`);
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function stopProcessGroup(child) {
  if (!child || child.exitCode != null) {
    return;
  }

  const signalTarget = process.platform === "win32" ? child.pid : -child.pid;

  try {
    process.kill(signalTarget, "SIGTERM");
  } catch {
    return;
  }

  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(5000).then(() => {
      try {
        process.kill(signalTarget, "SIGKILL");
      } catch {
        // process already exited
      }
    })
  ]);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
