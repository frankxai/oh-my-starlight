#!/usr/bin/env node
// Project the jev-decisions skill into a harness skills directory.
//
//   node jev/scripts/install-skill.mjs                 # -> ~/.config/opencode/skills/jev-decisions
//   node jev/scripts/install-skill.mjs --target <dir>  # any discovery root
//   node jev/scripts/install-skill.mjs --dry-run
//   node jev/scripts/install-skill.mjs --force         # replace an existing copy
//
// The package copy under jev/skills/ stays canonical; this only mirrors it so
// OpenCode (and anything else with the same layout) can discover the skill.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_SRC = join(SOURCE_DIR, "skills", "jev-decisions");
const SKILL_NAME = "jev-decisions";

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const targetRoot = String(
  flag("target", join(homedir(), ".config", "opencode", "skills")),
);
const dryRun = process.argv.includes("--dry-run");
const force = process.argv.includes("--force");
const destination = join(targetRoot, SKILL_NAME);

if (!existsSync(join(SKILL_SRC, "SKILL.md"))) {
  console.error(`Source skill missing: ${join(SKILL_SRC, "SKILL.md")}`);
  process.exit(2);
}

if (existsSync(destination) && !force) {
  const same =
    existsSync(join(destination, "SKILL.md")) &&
    statSync(join(destination, "SKILL.md")).size === statSync(join(SKILL_SRC, "SKILL.md")).size;
  console.error(
    `${same ? "Already installed" : "Destination exists"}: ${destination}\nRe-run with --force to replace it.`,
  );
  process.exit(dryRun ? 0 : 3);
}

if (dryRun) {
  console.log(JSON.stringify({ dryRun: true, from: SKILL_SRC, to: destination }, null, 2));
  process.exit(0);
}

mkdirSync(targetRoot, { recursive: true });
if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
cpSync(SKILL_SRC, destination, { recursive: true });

console.log(
  JSON.stringify(
    { installed: true, from: SKILL_SRC, to: destination, files: ["SKILL.md"] },
    null,
    2,
  ),
);
