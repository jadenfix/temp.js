#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { startBeaterDev, stopBeaterDev } = require("./gate-dev-server.cjs");

const root = path.resolve(__dirname, "..");
const targetDir = process.env.CARGO_TARGET_DIR || path.join(root, "target");
const beater = process.env.BEATER_BIN || path.join(targetDir, "debug", "beater");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "beater-pool-scaling."));
const app = path.join(tempRoot, "pool-app");
const evidencePath =
  process.env.BEATER_POOL_EVIDENCE || path.join(targetDir, "isolate-pool-scaling-evidence.json");

const available = os.availableParallelism?.() || os.cpus().length || 2;
const workers = positiveInt(process.env.BEATER_POOL_WORKERS, Math.max(2, Math.min(available, 10)));
const iterations = positiveInt(process.env.BEATER_POOL_ITERATIONS, 8_000_000);
const durationMs = positiveInt(process.env.BEATER_POOL_DURATION_MS, 4_000);
const warmupMs = positiveInt(process.env.BEATER_POOL_WARMUP_MS, 1_000);
const thresholdFactor = Number(process.env.BEATER_POOL_THRESHOLD_FACTOR || "0.60");
const minScaledRatio = Number(process.env.BEATER_POOL_MIN_RATIO || String(workers * thresholdFactor));

if (!Number.isFinite(thresholdFactor) || thresholdFactor <= 0 || thresholdFactor > 1) {
  fail(`invalid BEATER_POOL_THRESHOLD_FACTOR: ${process.env.BEATER_POOL_THRESHOLD_FACTOR}`);
}
if (!Number.isFinite(minScaledRatio) || minScaledRatio <= 1) {
  fail(`invalid BEATER_POOL_MIN_RATIO: ${process.env.BEATER_POOL_MIN_RATIO}`);
}

main().catch((error) => {
  cleanup();
  fail(error.stack || error.message || String(error));
});

async function main() {
  if (process.env.BEATER_SKIP_BUILD !== "1" || !fs.existsSync(beater)) {
    run("cargo", ["build", "-p", "beater-cli"], { cwd: root });
  }

  run(beater, ["new", app], { cwd: root, env: runtimeEnv(), stdio: "pipe" });
  writeCpuRoute();

  const one = await measureWorkers(1);
  const many = await measureWorkers(workers);
  const ratio = many.rps / one.rps;
  const perWorkerEfficiency = ratio / workers;
  const passed = ratio >= minScaledRatio;

  const evidence = {
    passed,
    route: "/api/cpu",
    iterations,
    durationMs,
    warmupMs,
    availableParallelism: available,
    workers,
    threshold: {
      minScaledRatio,
      perWorkerFactor: thresholdFactor,
    },
    measurements: {
      oneWorker: one,
      workerPool: many,
      ratio,
      perWorkerEfficiency,
    },
  };
  fs.mkdirSync(path.dirname(evidencePath), { recursive: true });
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);

  cleanup();

  if (!passed) {
    fail(
      `isolate pool scaling gate failed: ` +
        `1 worker ${one.rps.toFixed(2)} rps, ` +
        `${workers} workers ${many.rps.toFixed(2)} rps, ` +
        `ratio ${ratio.toFixed(2)} < ${minScaledRatio.toFixed(2)}; ` +
        `evidence: ${evidencePath}`,
    );
  }

  console.log(
    `isolate pool scaling gate passed: ` +
      `1 worker ${one.rps.toFixed(2)} rps; ` +
      `${workers} workers ${many.rps.toFixed(2)} rps; ` +
      `ratio ${ratio.toFixed(2)}x; evidence ${evidencePath}`,
  );
}

async function measureWorkers(count) {
  writeWorkers(count);
  const server = await startBeaterDev({
    beater,
    app,
    root,
    env: cleanedEnv(),
    timeoutMs: 20_000,
  });
  try {
    const concurrency = Math.max(8, count * 8);
    await benchmark(server.base, { concurrency, durationMs: warmupMs, count: false });
    const result = await benchmark(server.base, { concurrency, durationMs, count: true });
    return {
      workers: count,
      concurrency,
      completed: result.completed,
      failed: result.failed,
      elapsedMs: result.elapsedMs,
      rps: result.completed / (result.elapsedMs / 1000),
    };
  } finally {
    await stopBeaterDev(server);
  }
}

function writeCpuRoute() {
  const routeDir = path.join(app, "app", "routes", "api");
  fs.mkdirSync(routeDir, { recursive: true });
  fs.writeFileSync(
    path.join(routeDir, "cpu.ts"),
    `
globalThis.__beaterCpuSink = globalThis.__beaterCpuSink ?? 0;

function burn(iterations) {
  let x = globalThis.__beaterCpuSink | 0;
  for (let i = 0; i < iterations; i += 1) {
    x = (Math.imul(x ^ i, 1664525) + 1013904223) | 0;
  }
  globalThis.__beaterCpuSink = x;
  return x;
}

export function GET(request) {
  const raw = Number(request.query.n ?? ${iterations});
  const iterations = Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100000000) : ${iterations};
  const value = burn(iterations);
  return {
    status: 200,
    headers: {"content-type": "application/json; charset=utf-8"},
    body: JSON.stringify({ok: true, value, iterations}),
  };
}
`.trimStart(),
  );
}

function writeWorkers(count) {
  const configPath = path.join(app, "beater.toml");
  let config = fs.readFileSync(configPath, "utf8");
  if (/^workers\s*=/m.test(config)) {
    config = config.replace(/^workers\s*=.*$/m, `workers = ${count}`);
  } else {
    config = config.replace("port = 3000\n", `port = 3000\nworkers = ${count}\n`);
  }
  fs.writeFileSync(configPath, config);
}

async function benchmark(base, { concurrency, durationMs, count }) {
  const agent = new http.Agent({
    keepAlive: true,
    maxSockets: concurrency,
  });
  const deadline = Date.now() + durationMs;
  const started = process.hrtime.bigint();
  let completed = 0;
  let failed = 0;
  let launched = 0;
  let stopped = false;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (!stopped) {
        if (Date.now() >= deadline) {
          stopped = true;
          break;
        }
        launched += 1;
        try {
          await requestCpu(base, agent);
          if (count) completed += 1;
        } catch (error) {
          failed += 1;
          if (failed <= 3) {
            console.error(`request failed: ${error.message}`);
          }
        }
      }
    }),
  );
  agent.destroy();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  if (count && completed === 0) {
    throw new Error(`no completed requests; launched=${launched} failed=${failed}`);
  }
  return { completed, failed, elapsedMs };
}

function requestCpu(base, agent) {
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/api/cpu?n=${iterations}`, { agent }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          return;
        }
        try {
          const payload = JSON.parse(body);
          if (payload.ok !== true) {
            reject(new Error(`unexpected payload: ${body.slice(0, 200)}`));
            return;
          }
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    req.setTimeout(10_000, () => {
      req.destroy(new Error("request timed out"));
    });
    req.on("error", reject);
  });
}

function cleanedEnv() {
  const env = runtimeEnv();
  delete env.ANTHROPIC_API_KEY;
  delete env.BEATER_BASE_URL;
  delete env.BEATER_MCP_TOKEN;
  delete env.BEATER_MCP_TRUSTED_ORIGINS;
  return env;
}

function runtimeEnv() {
  const env = { ...process.env };
  const frameworkPath = "/Library/Developer/CommandLineTools/Library/Frameworks";
  if (fs.existsSync(frameworkPath)) {
    env.DYLD_FRAMEWORK_PATH = env.DYLD_FRAMEWORK_PATH
      ? `${env.DYLD_FRAMEWORK_PATH}:${frameworkPath}`
      : frameworkPath;
  }
  return env;
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`expected positive integer, got ${raw}`);
  }
  return value;
}

function run(command, args, options = {}) {
  const result = childProcess.spawnSync(command, args, {
    cwd: root,
    env: runtimeEnv(),
    stdio: options.stdio || "inherit",
    ...options,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? result.stderr.toString("utf8") : "";
    fail(`${command} ${args.join(" ")} failed${stderr ? `:\n${stderr}` : ""}`);
  }
}

function cleanup() {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
