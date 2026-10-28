// models.json is the T3 model policy every stamped Models section and
// setup-pstack's sheet block derive from.
// parseModels checks its shape when the generator loads it, and a role label
// is the runtime join key between the sheet the user writes and the prose that
// tells the agent which role to look up.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { t3Regions } from "../tools/derive-t3.mjs";
import { loadModels, parseModels } from "../tools/generate.mjs";
import { markdownFiles } from "../tools/validate-skills.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const skillsDir = join(repoRoot, "plugins/pstack/skills");
const raw = JSON.parse(readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8"));
const models = loadModels();

describe("committed models.json", () => {
  test("the file stays one row per role so a role change is a one-line diff", () => {
    const text = readFileSync(join(repoRoot, "plugins/pstack/models.json"), "utf8");
    expect(text.match(/^\s*\{ "role"/gm)).toHaveLength(raw.roles.length);
  });

  test("a released sheet's strongest judgment line still names the hardest tasks role", () => {
    expect(raw.roles.find((r) => r.alias === "strongest judgment")?.role).toBe("hardest tasks");
  });
});

describe("parseModels", () => {
  const anySkill = () => true;
  const parse = (mutate, skillExists = anySkill) => {
    const policy = structuredClone(raw);
    mutate(policy);
    return () => parseModels(policy, skillExists);
  };
  const role = (policy, label) => policy.roles.find((r) => r.role === label);

  test.each(["default", "strongest", "panel"])("a missing %s tier throws naming it", (tier) => {
    expect(parse((p) => delete p.tiers[tier])).toThrow(`models.json: tiers has no "${tier}"`);
  });

  test("a tier entry outside the T3 sheet grammar throws naming the tier", () => {
    expect(parse((p) => (p.tiers.default = "opus"))).toThrow(
      'models.json: tier "default": "opus" does not start with <providerInstanceId>/<modelId>',
    );
    expect(parse((p) => (p.tiers.strongest = "inherit-parent"))).toThrow(
      'models.json: tier "strongest" must name a target, not inherit the parent',
    );
    expect(parse((p) => (p.tiers.default = "claudeAgent/claude-opus-5-5  effort=xhigh"))).toThrow(
      "is not one entry written with single spaces",
    );
  });

  test("a single-model tier holds one entry and the panel a list of two families", () => {
    expect(parse((p) => (p.tiers.default = [p.tiers.default]))).toThrow('models.json: tier "default" must be one entry, not a list');
    expect(parse((p) => (p.tiers.panel = ["claudeAgent/claude-opus-5-5", "claudeAgent/claude-fable-5-1"]))).toThrow(
      "models.json: the panel needs at least two model families",
    );
    expect(parse((p) => (p.tiers.panel = ["codex/gpt-6.1-sol", "codex/gpt-6.1-sol"]))).toThrow(
      'models.json: tier "panel" lists an entry twice',
    );
  });

  test("a role naming an undefined tier throws naming the role and the tier", () => {
    expect(parse((p) => (role(p, "bug-fix").tier = "strongset"))).toThrow(
      'models.json: role "bug-fix" names tier "strongset", which tiers does not define',
    );
  });

  test("a duplicate role label or alias throws naming it", () => {
    expect(parse((p) => p.roles.push({ ...role(p, "how explorer") }))).toThrow('models.json: role "how explorer" appears twice');
    expect(parse((p) => (role(p, "bug-fix").alias = "strongest judgment"))).toThrow(
      'models.json: role "strongest judgment" appears twice',
    );
  });

  test("a role whose skill directory does not exist throws naming both", () => {
    expect(parse(() => {}, (skill) => skill !== "why")).toThrow(
      'models.json: role "why investigators" names skill "why", which has no SKILL.md',
    );
  });
});

describe("role labels reach the prose", () => {
  // The prose may hyphenate a label ("how-explorer" for the sheet's
  // "how explorer") and names only the first segment of a comma-joined label.
  const normalize = (text) => text.toLowerCase().replace(/[-\s]+/g, " ");

  function skillProse(skill) {
    return markdownFiles(join(skillsDir, skill))
      .map((file) => {
        const lines = readFileSync(file, "utf8").split("\n");
        const owned = t3Regions(models)
          .filter((r) => r.file === relative(repoRoot, file))
          .map((r) => r.locate(lines))
          .filter(Boolean);
        return lines.filter((_, i) => !owned.some(([s, e]) => i >= s && i < e)).join("\n");
      })
      .join("\n");
  }

  for (const role of models.roles) {
    test(`"${role.role}" is named by the ${role.skill} skill outside its stamped regions`, () => {
      const needle = normalize(role.role.split(",")[0]);
      expect(normalize(skillProse(role.skill))).toContain(needle);
    });
  }
});
