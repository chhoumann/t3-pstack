// The runtimes other than Claude Code that pstack ships to: the table the
// generator iterates, with each runtime's Model names renderer, models.json
// check, versioned manifest, packaging validator, and hooks files.

import { panelFamilies, parseEntry } from "../plugins/pstack/skills/setup-pstack/scripts/t3-sheet.mjs";
import { code, codeList, PLUGIN, SKILLS } from "./plugin.mjs";

// Every runtime other than Claude Code that reads the skills through a mapping
// file under poteto-mode/references/. A row gives the runtime its models.json
// block (`key`, checked by `checkModels`) and the generated Model names section
// in its mapping file. A `skillPreambles` runtime also gets a preamble under
// the first heading of each skill its Per-skill notes table lists, and a
// runtime with a `prompts` directory a slash stub per public skill there. Pi
// has neither: its one pointer is hand-written in poteto-mode's Platform
// Adaptation section. `manifest` is the file the generator stamps VERSION
// into, `validate` checks the runtime's packaging against the tree once that
// manifest parses, and `hooks` lists the hooks files the manifest names,
// relative to the plugin root.
export const RUNTIMES = [
  {
    name: "Codex",
    key: "codex",
    mapping: "codex-tools.md",
    modelNames: codexModelNamesSection,
    checkModels: checkCodexModels,
    skillPreambles: true,
    prompts: `${PLUGIN}/.codex-plugin/prompts`,
    manifest: `${PLUGIN}/.codex-plugin/plugin.json`,
    validate: ({ manifest, read, pathExists }) =>
      validateCodexMarketplace(read(".agents/plugins/marketplace.json"), { expectedName: manifest.name, pathExists }),
    hooks: (manifest) => [manifest.hooks],
  },
  {
    name: "Pi",
    key: "pi",
    mapping: "pi-tools.md",
    modelNames: piModelNamesSection,
    checkModels: checkPiModels,
    manifest: "package.json",
    validate: ({ text, pathExists }) => validatePiPackage(text, { pathExists }),
  },
  // T3 is not a build: t3-pstack ships in the Claude Code and Codex manifests
  // and dispatches through the t3-code MCP tools on either host, so its row has
  // no manifest. It comes last so its preamble wins on a skill both tables list.
  {
    name: "T3",
    key: "t3",
    mapping: "t3-tools.md",
    modelNames: t3ModelNamesSection,
    checkModels: checkT3Models,
    skillPreambles: true,
  },
].map((runtime) => ({
  ...runtime,
  tools: `${SKILLS}/poteto-mode/references/${runtime.mapping}`,
  notesHeader: `| Skill | On ${runtime.name} |`,
  preamble: runtime.skillPreambles
    ? `On ${runtime.name}, read the [platform mapping](../poteto-mode/references/${runtime.mapping}), ` +
      "including its per-skill notes, before following this skill."
    : null,
}));

// Codex has no Claude aliases, so its block gives an example model per tier.
function checkCodexModels(codex, { raw, fail, unique }) {
  for (const tier of Object.keys(raw.tiers)) {
    if (!Object.hasOwn(codex, tier)) fail(`codex has no example for tier "${tier}"`);
  }
  for (const [tier, value] of Object.entries(codex)) {
    if (!Object.hasOwn(raw.tiers, tier)) fail(`codex names "${tier}", which is not a tier`);
    unique([value].flat(), `codex "${tier}"`);
  }
}

// The pstack Pi extension resolves each Claude alias a skill names through the
// table of the session's provider, or the fallback table on any other provider,
// so every table maps exactly the available aliases to that provider's models.
function checkPiModels(pi, { raw, fail, isObject }) {
  for (const key of Object.keys(pi)) {
    if (key !== "fallback" && key !== "models") fail(`pi names "${key}"; its keys are "fallback" and "models"`);
  }
  if (!isObject(pi.models)) fail('pi needs a "models" object');
  if (!Object.hasOwn(pi.models, pi.fallback)) fail(`pi.fallback "${pi.fallback}" is not a provider in pi.models`);
  for (const [provider, table] of Object.entries(pi.models)) {
    const at = `pi.models.${provider}`;
    if (!isObject(table)) fail(`${at} must be an object`);
    for (const alias of raw.available) {
      if (!Object.hasOwn(table, alias)) fail(`${at} has no Pi model for "${alias}"`);
    }
    for (const [alias, id] of Object.entries(table)) {
      if (!raw.available.includes(alias)) fail(`${at} names "${alias}", which is not in available`);
      if (typeof id !== "string" || !id.startsWith(`${provider}/`) || /\s/.test(id) || id === `${provider}/`) {
        fail(`${at} "${alias}" is "${id}", not a ${provider}/<id>`);
      }
    }
  }
}

// Every tier needs a T3 target in the sheet grammar of setup-pstack's
// t3-sheet.mjs, the panel must span families, and every role must name a tier
// so the T3 sheet can follow it.
function checkT3Models(t3, { raw, fail, unique }) {
  for (const tier of Object.keys(raw.tiers)) {
    if (!Object.hasOwn(t3, tier)) fail(`t3 has no target for tier "${tier}"`);
  }
  for (const [tier, value] of Object.entries(t3)) {
    if (!Object.hasOwn(raw.tiers, tier)) fail(`t3 names "${tier}", which is not a tier`);
    if (tier !== "panel" && typeof value !== "string") fail(`t3 "${tier}" must be one target, not a list`);
    unique([value].flat(), `t3 "${tier}"`);
    const entries = [value].flat().map((entry) => {
      if (typeof entry !== "string" || entry !== entry.trim().split(/\s+/).join(" ")) {
        fail(`t3 "${tier}": ${JSON.stringify(entry)} is not one target written with single spaces`);
      }
      let parsed;
      try {
        parsed = parseEntry(entry);
      } catch (err) {
        fail(`t3 "${tier}": ${err.message}`);
      }
      if (!parsed) fail(`t3 "${tier}" must name a target, not inherit the parent`);
      return parsed;
    });
    if (tier === "panel" && panelFamilies(entries).size < 2) fail("t3 panel needs at least two model families");
  }
  for (const role of raw.roles) {
    if (typeof role.models !== "string") fail(`role "${role.role}" lists models; the t3 sheet needs it to name a tier`);
  }
}

export function t3ModelNamesSection(models) {
  const rows = models.roles.map((r) => `${r.role}: ${[models.t3[r.tier]].flat().join(", ")}`).join("\n");
  return (
    "On T3 the sheet names T3 targets, not the Claude aliases in each skill's Models section. Resolve every role " +
    "from the sheet (see [The sheet](#the-sheet)). A role with no line runs on its tier's default below, and the " +
    "aliases in the skills' Models sections do not apply. The defaults, as a complete sheet:\n\n" +
    "```markdown\n# pstack model configuration (T3)\n\n" +
    rows +
    "\n\nsession hook: on\n```"
  );
}

export function codexModelNamesSection(models) {
  const strongest = models.roles.filter((r) => r.tier === "strongest");
  return (
    "Skills name Claude defaults (a single-role default for code/prose/judgment plus a diverse-model panel for " +
    "diverse-model panels; each model-consuming skill lists its own in a Models section). These slugs do not " +
    "resolve on Codex. Substitute your configured Codex models:\n\n" +
    `- Single-model roles: your primary Codex model (for example ${code(models.codex.default)}).\n` +
    `- Roles that default to the strongest Claude model (${strongest.map((r) => code(r.role)).join(", ")}): ` +
    `your strongest Codex model (for example ${code(models.codex.strongest)}).\n` +
    "- Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`): the adversarial " +
    "signal comes from model diversity, so use the distinct Codex models available to you. A good default panel " +
    `on ChatGPT is ${codeList(models.codex.panel)}. If only one model family is reachable, vary reasoning ` +
    "effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Codex, set it to your Codex model slugs."
  );
}

export function piModelNamesSection(models) {
  const { fallback, models: tables } = models.pi;
  const columns = Object.keys(tables);
  const table =
    `| Alias | ${columns.map(code).join(" | ")} |\n| --- |${" --- |".repeat(columns.length)}\n` +
    models.available.map((alias) => `| ${code(alias)} | ${columns.map((p) => code(tables[p][alias])).join(" | ")} |`).join("\n");
  return (
    "Skills name models by the Claude aliases in their Models sections. On Pi, pass the alias as the `agent` " +
    "tool's `model`. The pstack extension resolves it in the column of the provider the session's current model " +
    `comes from, and in the ${code(fallback)} column for any other provider:\n\n` +
    table +
    "\n\nPi warns that Anthropic bills Claude used through Pi per token, as extra usage, even on a Claude subscription. " +
    "Pi shows that warning only in interactive mode, never for the `pi --mode rpc` children the `agent` tool runs.\n\n" +
    "A `pi models: opus=<provider/id>, sonnet=<provider/id>` line in the Pi override sheet points each alias " +
    "it names at another Pi model, whatever the session's provider. The `agent` tool also takes a full " +
    "`provider/id`, passed through unchanged, and `inherit-parent`, `auto`, or no `model` runs the child on the " +
    "parent's current model. Diverse-model panels (`arena`, `architect`, `interrogate`, `how` critics, `reflect`) " +
    "stay diverse only while their aliases resolve to distinct models. If one model family is all you can reach, " +
    "vary the reasoning effort and note in the verdict that diversity was reduced.\n\n" +
    "`/setup-pstack` writes the configured model list. On Pi, keep the aliases and remap them with `pi models:`."
  );
}

export function validateCodexMarketplace(text, { expectedName, pathExists }) {
  const manifest = JSON.parse(text);
  const plugins = manifest.plugins ?? [];
  if (plugins.length !== 1) {
    throw new Error(`.agents/plugins/marketplace.json: expected 1 plugin entry, found ${plugins.length}`);
  }
  const [plugin] = plugins;
  if (plugin.name !== expectedName) {
    throw new Error(
      `.agents/plugins/marketplace.json: plugin name "${plugin.name}" != Codex manifest name "${expectedName}"`,
    );
  }
  const path = plugin.source?.path;
  if (!path || !pathExists(path)) {
    throw new Error(`.agents/plugins/marketplace.json: source.path "${path}" does not resolve to a directory`);
  }
}

const PI_PACKAGE = { skills: SKILLS, extensions: `${PLUGIN}/pi/index.ts` };

// `pi install` reads the repo-root package.json's `pi` key. A path there that
// does not exist loads nothing without failing the install, and an entry the
// key omits never loads, so both directions are checked here.
export function validatePiPackage(text, { pathExists }) {
  const manifest = JSON.parse(text);
  const fail = (message) => {
    throw new Error(`package.json: ${message}`);
  };
  if (!manifest.keywords?.includes("pi-package")) fail('keywords must include "pi-package"');
  if (Object.keys(manifest.dependencies ?? {}).length) fail("the Pi package has no runtime dependencies");
  for (const [key, required] of Object.entries(PI_PACKAGE)) {
    const listed = manifest.pi?.[key] ?? [];
    for (const path of listed) {
      if (!pathExists(path.replace(/^\.\//, ""))) fail(`pi.${key} names ${path}, which does not exist`);
    }
    if (!listed.includes(`./${required}`)) fail(`pi.${key} must list ./${required}`);
  }
}
