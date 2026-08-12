import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";

const REFERENCE_DIR = join(import.meta.dirname, "../.reference");

const repos = [
  {
    name: "AnswerOverflow",
    url: "https://github.com/AnswerOverflow/AnswerOverflow.git",
  },
  { name: "accountability", url: "https://github.com/mikearnaldi/accountability.git" },
  { name: "agents", url: "https://github.com/cloudflare/agents.git" },
  { name: "ai-automation", url: "https://github.com/typeonce-dev/ai-automation.git" },
  { name: "alchemy", url: "https://github.com/alchemy-run/alchemy.git" },
  { name: "anti-slop", url: "https://github.com/dmmulroy/anti-slop.git" },
  { name: "cf-twitch", url: "https://github.com/dmmulroy/cf-twitch.git" },
  { name: "codex", url: "https://github.com/openai/codex.git" },
  { name: "deepagentsjs", url: "https://github.com/langchain-ai/deepagentsjs.git" },
  { name: "effect", url: "https://github.com/Effect-TS/effect.git" },
  { name: "effect-atom", url: "https://github.com/tim-smart/effect-atom.git" },
  { name: "effect-examples", url: "https://github.com/Effect-TS/examples.git" },
  { name: "executor", url: "https://github.com/UsefulSoftwareCo/executor.git" },
  { name: "hermes-agent", url: "https://github.com/NousResearch/hermes-agent.git" },
  { name: "openai-agents-js", url: "https://github.com/openai/openai-agents-js.git" },
  { name: "opencode", url: "https://github.com/anomalyco/opencode.git" },
  {
    name: "openrouter-typescript-agent",
    url: "https://github.com/OpenRouterTeam/typescript-agent.git",
  },
  { name: "t3code", url: "https://github.com/pingdotgg/t3code.git" },
];

await mkdir(REFERENCE_DIR, { recursive: true });

await Promise.all(
  repos.map(async (repo) => {
    const dest = join(REFERENCE_DIR, repo.name);
    if (existsSync(dest)) {
      console.log(`Pulling ${repo.name}...`);
      await $`git -C ${dest} pull --ff-only`.quiet();
    } else {
      console.log(`Cloning ${repo.name}...`);
      await $`git clone --depth 1 ${repo.url} ${dest}`.quiet();
    }
    console.log(`  ✓ ${repo.name}`);
  }),
);
