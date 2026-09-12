#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const MIN_NODE = [24, 16, 0];
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const OPENCLAW_VERSION = "2026.9.4";

function fail(message) {
  console.error(`[agent] ${message}`);
  process.exit(1);
}

function assertSupportedNode() {
  const current = process.versions.node.split(".").map(Number);
  const supported24 = current[0] === 24 && (
    current[1] > MIN_NODE[1] || (current[1] === MIN_NODE[1] && current[2] >= MIN_NODE[2])
  );
  const supported26 = current[0] > 26 || (current[0] === 26 && current[1] >= 1);
  if (!supported24 && !supported26) {
    fail(`OpenClaw requires Node 24.16+ (below 25) or 26.1+. Run: nvm install && nvm use`);
  }
}

const repoDir = process.cwd();
const openclawEntry = path.join(repoDir, "node_modules", "openclaw", "openclaw.mjs");
const stateDir = path.resolve(process.env.ALLOC_OPENCLAW_STATE_DIR ?? path.join(repoDir, ".context", "openclaw"));
const configPath = path.join(stateDir, "openclaw.json");
const model = process.env.ALLOC_AGENT_MODEL ?? DEFAULT_MODEL;
const openclawEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
};

function openclaw(args, options = {}) {
  const result = spawnSync(process.execPath, [openclawEntry, ...args], {
    cwd: repoDir,
    env: openclawEnv,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) fail(result.error.message);
  return result;
}

function requireSuccess(result, action) {
  if (result.status === 0) return;
  const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  fail(`${action} failed${detail ? `: ${detail}` : ""}`);
}

async function setup() {
  assertSupportedNode();
  if (!existsSync(openclawEntry)) {
    fail("OpenClaw is not installed. Run npm ci first.");
  }
  await mkdir(stateDir, { recursive: true });

  if (model.startsWith("deepseek/")) {
    const installed = openclaw(["plugins", "inspect", "deepseek", "--json"], { capture: true });
    if (installed.status !== 0) {
      requireSuccess(
        openclaw(["plugins", "install", `@openclaw/deepseek-provider@${OPENCLAW_VERSION}`, "--pin"], { capture: true }),
        "DeepSeek provider installation",
      );
    }
    if (!process.env.DEEPSEEK_API_KEY) {
      fail("DEEPSEEK_API_KEY is required for the configured DeepSeek model.");
    }
  }

  requireSuccess(openclaw(["models", "set", model], { capture: true }), "model selection");
  requireSuccess(openclaw(["config", "set", "tools.profile", "minimal"], { capture: true }), "tool policy setup");
  return { model, stateDir };
}

function parseEnvelope(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    fail(`OpenClaw returned invalid JSON: ${error.message}`);
  }
}

async function smoke() {
  const configured = await setup();
  const marker = "alloc-deepseek-ok";
  const result = openclaw([
    "agent", "exec", `Reply with exactly: ${marker}`,
    "--thinking", "off", "--timeout", "60", "--json",
  ], { capture: true });
  requireSuccess(result, "live agent smoke test");
  const envelope = parseEnvelope(result.stdout);
  if (envelope.ok !== true || envelope.final?.trim() !== marker) {
    fail(`unexpected live response: ${JSON.stringify({ ok: envelope.ok, final: envelope.final })}`);
  }
  console.log(`[agent] live OpenClaw -> ${configured.model} E2E passed (${envelope.usage?.total ?? "unknown"} tokens)`);
}

async function chat(prompt) {
  await setup();
  const result = openclaw([
    "agent", "exec", prompt,
    "--thinking", process.env.ALLOC_AGENT_THINKING ?? "off",
    "--timeout", process.env.ALLOC_AGENT_TIMEOUT_SECONDS ?? "120",
  ]);
  process.exit(result.status ?? 1);
}

const [command = "chat", ...args] = process.argv.slice(2);
if (command === "setup") {
  const configured = await setup();
  console.log(`[agent] ready: ${configured.model} (state: ${configured.stateDir})`);
} else if (command === "smoke") {
  await smoke();
} else if (command === "chat") {
  const prompt = args.join(" ").trim();
  if (!prompt) fail('Usage: npm run agent -- "your question"');
  await chat(prompt);
} else {
  fail(`unknown command: ${command}`);
}
