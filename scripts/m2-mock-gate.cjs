#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const sourceApp = process.env.BEATER_APP ?? path.join(root, "examples/hello");
const workdir =
  process.env.M2_MOCK_WORKDIR ?? path.join(root, "target", "m2-mock-gate", `${stamp}-pid${process.pid}`);
const app = process.env.BEATER_APP ? sourceApp : path.join(workdir, "hello");
const beater = process.env.BEATER_BIN ?? path.join(root, "target/debug/beater");
const out =
  process.env.M2_GATE_OUT ?? path.join(app, ".beater", "m2-mock-gate", `${stamp}-pid${process.pid}`);

if (!fs.existsSync(beater)) {
  console.error(`missing beater binary: ${beater}`);
  console.error("run: cargo build -p beater-cli");
  process.exit(1);
}
if (!process.env.BEATER_APP) {
  copyApp(sourceApp, app);
}

const requests = [];
const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/messages") {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }

  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const request = JSON.parse(body);
      const response = responseFor(request);
      requests.push({ request, response });
      const payload = JSON.stringify(response);
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    } catch (error) {
      const payload = JSON.stringify({ error: String(error.stack ?? error) });
      res.writeHead(500, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload),
      });
      res.end(payload);
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: "mock-key",
    ANTHROPIC_BASE_URL: baseUrl,
    BEATER_APP: app,
    BEATER_BIN: beater,
    M2_GATE_OUT: out,
  };

  const code = await runGate(env);
  server.close();
  if (code !== 0) {
    process.exit(code);
  }
  if (requests.length !== 5) {
    console.error(`expected 5 mock Messages API requests, got ${requests.length}`);
    process.exit(1);
  }
  console.log(`mock M2 gate passed: ${out}`);
});

function runGate(env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.join(root, "scripts/m2-live-gate.sh")], {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("close", resolve);
  });
}

function responseFor(body) {
  const toolResult = lastToolResult(body);
  if (toolResult === "toolu_mock_a3") {
    return textResponse("summarize_numbers returned mean 2.8.");
  }
  if (toolResult === "toolu_mock_a4") {
    return textResponse("slow_summarize resumed and completed.");
  }

  const prompt = firstUserText(body);
  if (prompt.includes("slow_summarize_once")) {
    return toolUseResponse("toolu_mock_a5", "slow_summarize_once");
  }
  if (prompt.includes("slow_summarize")) {
    return toolUseResponse("toolu_mock_a4", "slow_summarize");
  }
  if (prompt.includes("summarize_numbers")) {
    return toolUseResponse("toolu_mock_a3", "summarize_numbers");
  }
  throw new Error(`unexpected mock request messages: ${JSON.stringify(body.messages)}`);
}

function firstUserText(body) {
  const message = (body.messages ?? []).find((entry) => entry.role === "user");
  return typeof message?.content === "string" ? message.content : "";
}

function lastToolResult(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  if (!Array.isArray(last?.content)) {
    return "";
  }
  const block = last.content.find((entry) => entry.type === "tool_result");
  return typeof block?.tool_use_id === "string" ? block.tool_use_id : "";
}

function toolUseResponse(id, name) {
  return {
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name,
        input: { numbers: [3, 1, 4, 1, 5] },
      },
    ],
    stop_reason: "tool_use",
  };
}

function textResponse(text) {
  return {
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  };
}

function copyApp(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".beater" || entry.name === ".venv") {
      continue;
    }
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyApp(src, dst);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(src), dst);
    }
  }
}
