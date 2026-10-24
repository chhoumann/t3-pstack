#!/usr/bin/env node
// The dedicated agystack projection CLI.
//
//   install  project the agystack Antigravity plugin into <gemini-home>/skills
//   doctor   read-only report on the projection and its manifest
//
// It writes nothing outside the destination skills directory, and leaves the
// general installer in tools/install.mjs untouched.
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

import { expandHome } from "./install/common.mjs";
import { ADAPTER_RESOURCE_PATH, MANIFEST_NAME, buildProjection, doctor, project } from "./install/agystack.mjs";

const USAGE = `usage: node tools/antigravity.mjs install|doctor [--gemini-home DIR] [--agystack-source DIR] [--json]

install projects the agystack Antigravity plugin into <gemini-home>/skills as
flat, manifest-owned skill directories. doctor reports drift, broken links,
and the state of the cloud bridge (${ADAPTER_RESOURCE_PATH}).

Exit codes: 0 success, 1 blocked install or degraded doctor, 2 usage error.
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
      emit(
        options,
        {
          status: "blocked",
          problems: error.problems,
          dest: destSkillsDir,
          manifest: join(destSkillsDir, MANIFEST_NAME),
        },
        [`install blocked before any write (nothing was written):`, ...error.problems.map((p) => `  ${p.code} ${p.path}: ${p.detail}`)].join("\n"),
      );
      process.exit(1);
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
      `  cloud bridge (${ADAPTER_RESOURCE_PATH}): ${report.adapterResource.projected ? `projected with ${report.adapterResource.projectedFiles} script file(s)` : report.adapterResource.bundled ? "bundled but not projected" : "not shipped by the installed package"}`,
    ];
    report.summary = lines.join("\n");
    emit(options, report, report.summary);
    process.exit(report.ok ? 0 : 1);
  }
  usageError(`unknown verb "${options.verb}"`);
}

main();
