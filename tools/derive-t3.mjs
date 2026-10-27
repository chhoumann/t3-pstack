// The T3 form of an upstream file, as tools/sync.mjs derives it after the
// substitutions and tools/generate.mjs stamps it: the port's frontmatter, then
// the regions rendered from plugins/pstack/models.json. The T3 dispatch rules
// themselves live in the text, as substitutions, so nothing here stamps a
// runtime preamble.

import { code } from "./plugin.mjs";

// Split a Markdown file into its YAML frontmatter and the text after it.
// `data` is null when the file does not open with a frontmatter block.
export function parseFrontmatter(text) {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) return { data: null, body: text };
  return { data: Bun.YAML.parse(block[1]) ?? {}, body: text.slice(block[0].length) };
}

// Frontmatter keys only Cursor reads. The port drops each with any indented
// continuation lines and blank paragraphs.
const CURSOR_ONLY_KEYS = /^(?:mode|icon|color|reminder|is_background):/;

// The skill the session-start hook invokes by name. Upstream marks every skill
// disable-model-invocation: true, which makes the Skill tool refuse it, so the
// port drops the flag here and nowhere else. The other skills stay manual-only,
// as upstream ships them, and poteto-mode reads them by path.
export const ROUTED_SKILL = "poteto-mode";

// The port's frontmatter for an upstream skill or plugin agent: `name` is the
// skill's directory or the agent's file name, which is how Claude Code and
// Codex register it, and Cursor-only keys go.
export function portFrontmatter(file, text) {
  const skill = file.match(/^plugins\/pstack\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
  const name = skill ?? file.match(/^plugins\/pstack\/agents\/([^/]+)\.md$/)?.[1];
  if (!name) return text;
  const { body } = parseFrontmatter(text);
  const kept = [];
  let dropping = false;
  for (const line of text.slice(0, text.length - body.length).split("\n")) {
    dropping = CURSOR_ONLY_KEYS.test(line) || (dropping && /^(?:\s|$)/.test(line));
    if (dropping) continue;
    if (skill === ROUTED_SKILL && line === "disable-model-invocation: true") continue;
    kept.push(line.startsWith("name:") ? `name: ${name}` : line);
  }
  return kept.join("\n") + body;
}

// Locators find a stamped span of a file and return its [start, end) line
// range, or null when the anchor is absent.

// The body of a "## <title>" section: everything up to the next "## " heading or EOF.
export const section = (title) => (lines) => {
  const start = lines.indexOf(`## ${title}`);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return [start + 1, end];
};

// The inside of the first ```<lang> fence after the `### N. <title>` step
// heading. The ordinal is not part of the anchor.
export const fenceUnder = (title, lang) => (lines) => {
  const step = lines.findIndex((l) => l.replace(/^### \d+\. /, "### ") === `### ${title}`);
  if (step === -1) return null;
  const open = lines.indexOf("```" + lang, step);
  if (open === -1) return null;
  const close = lines.indexOf("```", open + 1);
  return close === -1 ? null : [open + 1, close];
};

const SHEET =
  "A role line in the model sheet overrides each one. The sheet is `~/.config/t3-pstack/models.md` " +
  "(`$XDG_CONFIG_HOME/t3-pstack/models.md` when that is set), one per machine, and `/setup-pstack` writes it. " +
  "When it is missing, read `t3-pstack-models.md` in the host's config directory (`$CLAUDE_CONFIG_DIR` or " +
  "`~/.claude` on Claude Code, `$CODEX_HOME` or `~/.codex` on Codex). An entry is `<providerInstanceId>/<modelId>` plus `<optionId>=<value>` pairs, and it " +
  "maps onto `delegate_task`'s `target`, with the provider instance as `providerInstanceId`, the model as `model`, " +
  "and the pairs as `options`. It splits at its first `/`, so a model ID with its own `/`, such as OpenCode's " +
  "`<provider>/<model>`, is written whole after it. Option IDs differ per provider, so take them from " +
  "`orchestrator_capabilities`. `inherit-parent` or `auto` omits `target`.";

export const entries = (models, role) => [models.tiers[role.tier]].flat();

const roleLine = (models, r) =>
  `- ${r.role}: ${entries(models, r).map(code).join(", ")}` +
  (r.alias ? ` (a \`${r.alias}\` line counts as this role)` : "");

export function modelsSection(models, roles) {
  return `Role defaults on T3, stamped from \`plugins/pstack/models.json\`. ${SHEET}\n\n${roles.map((r) => roleLine(models, r)).join("\n")}`;
}

// The sheet setup-pstack writes when the user keeps every default.
export function sheetBlock(models) {
  const rows = models.roles.map((r) => `${r.role}: ${entries(models, r).join(", ")}`);
  return [
    "# pstack model configuration (T3). One line per role. Delete a line to fall back to the skill default.",
    "# `inherit-parent` or `auto` as a value: the role runs on the parent chat's model (`delegate_task` omits `target`). Alias entries in a panel list still count toward its fan-out.",
    "# budget: large (xhigh)",
    ...rows,
    "session hook: on",
  ];
}

const skillFile = (skill) => `plugins/pstack/skills/${skill}/SKILL.md`;
const padded = (text) => ["", ...text.split("\n"), ""];

// Every stamped region: its file, how to find it, and what it renders. A region
// with `appendHeading` is added as the last H2 when the file lacks it.
export function t3Regions(models) {
  const bySkill = Map.groupBy(models.roles, (r) => r.skill);
  return [
    ...[...bySkill].map(([skill, roles]) => ({
      file: skillFile(skill),
      name: "Models section",
      locate: section("Models"),
      appendHeading: "## Models",
      render: () => padded(modelsSection(models, roles)),
    })),
    {
      file: skillFile("setup-pstack"),
      name: "sheet block",
      locate: fenceUnder("Write the sheet", "markdown"),
      render: () => sheetBlock(models),
    },
  ];
}

// Stamp every region in `file` (repo-relative). With strict, a missing anchor
// throws, because a stamped region is a contract with the file. Without it, a
// region whose anchor upstream lacks is left alone, so the file surfaces in the
// sync as forked or conflicted instead of aborting it.
export function applyRegions(file, text, models, { strict = false } = {}) {
  const lines = text.split("\n");
  const regions = t3Regions(models).filter((r) => r.file === file);
  for (const region of regions.filter((r) => r.appendHeading)) {
    if (region.locate(lines)) continue;
    if (lines.at(-1) !== "") lines.push("");
    lines.push(region.appendHeading, "");
  }
  for (const region of regions) {
    const range = region.locate(lines);
    if (!range) {
      if (strict) throw new Error(`${file}: no anchor for the ${region.name} to stamp`);
      continue;
    }
    lines.splice(range[0], range[1] - range[0], ...region.render());
  }
  return lines.join("\n");
}

export function deriveT3(file, text, models) {
  return applyRegions(file, portFrontmatter(file, text), models);
}
