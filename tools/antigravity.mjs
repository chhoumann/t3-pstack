#!/usr/bin/env node
// The dedicated agystack projection CLI. Titles:
//
//   install  project the agystack Antigravity plugin into `~/.gemini/config/skills`
//   doctor   read-only report on the projection and its manifest
//
// Shared flags:
//   --gemini-home DIR     the Gemini config home (default ~/.gemini/config)
//   --agystack-source DIR the agystack plugin directory to project from
//                         (default: plugins/agystack inside the gemini home)
//   --json                machine-readable report on stdout
//
// Exit codes: 0 success, 1 blocked install or degraded doctor, 2 usage error.
// The general installer in tools/install.mjs is not touched or orchestrated, and
// nothing outside the destination skills directory is written.
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

import { expandHome } from "./install/common.mjs";
import { ADAPTER_RESOURCE_PATH, MANIFEST_NAME, buildProjection, doctor, project } from "./install/agystack.mjs";

const USAGE = `usage: node tools/antigravity.mjs install|doctor [--gemini-home DIR] [--agystack-source DIR] [--json]

Reviews: install projects the agystack Antigravity plugin (source skills) into
<gemini-home>/skills as flat, manifest-owned skill directories. doctor reports
drift, broken links, and the state of the cloud bridge (${ADAPTER_RESOURCE_PATH}).

  install   project source skills, generated SKILL.md files, resource links
  doctor    read-only checks; exit 1 when the projection is degraded

Both verbs accept the flags above. --json replaces the human summary with one
JSON document. Install exits 1 without writing anything when validation fails
(collisions with user files, drift in owned generated files, a bad manifest).
`;

function parseArgs(argv) {
  const options = { verb: null, geminiHome: null, agystackSource: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--gemini-home" || arg === "--agystack-source") {
      const name = arg === "--gemini-home" ? "geminiHome" : "agystackSource";
      if (i + 1 >= argv.length) usageError(`${arg} needs a directory`);
      options[name] = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (options.verb === null && (arg === "install" || arg === "doctor")) {
      options.verb = arg;
      continue;
    }
    usageError(`unexpected argument "${arg}"`);
  }
  return options;
}

function usageError(message) {
  process.stderr.write(`antigravity: ${message}\n\n${USAGE}`);
  process.exit(2);
}

function emit(options, payload, human) {
  if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stdout.write(`${human}\n`);
}

function homes(options) {
  const home = homedir();
  const geminiHome = resolve(expandHome(options.geminiHome ?? join(home, ".gemini", "config"), home));
  return {
    geminiHome,
    destSkillsDir: join(geminiHome, "skills"),
    sourceRoot: resolve(expandHome(options.agystackSource ?? join(geminiHome, "plugins", "agystack"), home)),
    packageRoot: fileURLToPath(new URL("..", import.meta.url)),
  };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.verb) usageError("install or doctor expected");
  const { destSkillsDir, sourceRoot, packageRoot } = homes(options);
  if (!existsSync(sourceRoot)) usageError(`agystack source "${sourceRoot}" does not exist (pass --agystack-source)`);
  if (options.verb === "install") {
    const emitBlocked = (payload, human) => {
      emit(options, payload, human);
      process.exit(1);
    };
    try {
      const build = buildProjection({ sourceRoot, destSkillsDir, packageRoot });
      const result = project({ build });
      const counts = {
        generated: result.applied.filter((e) => e.kind === "generated-skill").length,
        adapterSkill: result.applied.filter((e) => e.kind === "adapter-skill").length,
        adapterResource: result.applied.filter((e) => e.kind === "adapter-resource").length,
        links: result.applied.filter((e) => e.kind === "resource-link").length,
      };
      const summary = `installed ${build.sourceSkillNames.length} agystack skill${build.sourceSkillNames.length === 1 ? "" : "s"} into ${destSkillsDir} (manifest ${MANIFEST_NAME}: ${build.entries.length} owned entries; this run wrote ${result.applied.length} paths, ${counts.generated} generated)`;
      emit(
        options,
        {
          status: "ok",
          dest: destSkillsDir,
          manifest: result.manifestPath,
          skills: build.sourceSkillNames,
          applied: result.applied.map((e) => e.path),
          skipped: result.skipped.map((e) => e.path),
          removed: result.removed.map((e) => e.path),
          counts,
        },
        summary,
      );
      process.exit(0);
    } catch (error) {
      if (error.name !== "ProjectionBlocked") throw error;
      emitBlocked(
        {
          status: "blocked",
          problems: error.problems,
          dest: destSkillsDir,
          manifest: join(destSkillsDir, MANIFEST_NAME),
        },
        [`install blocked before any write (nothing was written):`, ...error.problems.map((p) => `  ${p.code} ${p.path}: ${p.detail}`)].join("\n"),
      );
    }
  }
  if (options.verb === "doctor") {
    const report = doctor({ sourceRoot, destSkillsDir, packageRoot });
    const lines = [
      `agystack projection doctor "${sourceRoot}" -> "${destSkillsDir}"`,
      `  status: ${report.status}`,
      `  source: ${report.source.present ? report.source.skills.join(", ") : "not found"}`,
      `  manifest entries: ${report.manifest?.entries ?? "no manifest"}`,
      `  drift: ${report.drift.join(", ") || "none"}`,
      `  broken links: ${report.brokenLinks.map((l) => l.path).join(", ") || "none"}`,
      `  cloud bridge (${ADAPTER_RESOURCE_PATH}): ${report.adapterResource.projected ? "projected" : report.adapterResource.bundled ? "bundled but not projected" : "not shipped by the installed package"}`,
    ];
    report.summary = lines.join("\n");
    emit(options, report, report.summary);
    process.exit(report.ok ? 0 : 1);
  }
  usageError(`unknown verb "${options.verb}"`);
}

main();
