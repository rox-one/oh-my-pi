# System Prompt Customization

How the coding agent assembles its system prompt and what users can control with `SYSTEM.md`, `APPEND_SYSTEM.md`, `TITLE_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/system/system-prompt.md` (unified template; handles both default and custom prompts via `{{#if customPrompt}}` conditionals)
- `packages/coding-agent/src/prompts/system/project-prompt.md` (project/environment footer)

## Inputs and precedence

| Input                                   | Source                 | Effect                                                                                                   |
| --------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------- |
| `--system-prompt <text-or-file>`        | CLI                    | Uses the bundled custom-prompt template instead of the default instruction template. Highest precedence. |
| `SYSTEM.md`                             | Discovered config file | Same template switch as the flag; used when the flag is absent.                                          |
| `--append-system-prompt <text-or-file>` | CLI                    | Adds text to the rendered prompt. Highest append precedence.                                             |
| `APPEND_SYSTEM.md`                      | Discovered config file | Same effect as the append flag; used when the flag is absent.                                            |

`SYSTEM.md` and `APPEND_SYSTEM.md` are searched project-first, then user-level. At each scope the config bases are ordered `.omp`, `.claude`, `.codex`, `.gemini`:

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces the default System zone while preserving Runtime and Project. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.omp/SYSTEM.md`, then `~/.omp/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds the Append zone after the selected default/custom System and before Project. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

The native user path follows the active profile: with `omp --profile work`, `~/.omp/agent` becomes `~/.omp/profiles/work/agent`. `PI_CONFIG_DIR` changes the native config-directory name. This shared config lookup does not use `PI_CODING_AGENT_DIR` as an arbitrary replacement base.

Discovery does **not** walk ancestors. Starting OMP in `<repo>/packages/api` does not discover `<repo>/.omp/SYSTEM.md`; launch from `<repo>`, put the file under the current directory's config base, or use a user-level file. See [Configuration usage](./config-usage.md) for the shared config-directory contract.

A flag wins over every discovered file. For each filename, project scope wins over user scope and the first config base in the order above wins within that scope.

### Text or file resolution

For a single-line value, OMP first tries to read that value as a file path. If reading fails because the path does not exist (or is too long to be a path), the value is used literally. A value containing a newline is used literally without a file read. Other file-read failures are logged and the original value is still used literally.

## 2) Runtime, System, Append, and Project

CLI startup passes resolved `SYSTEM.md` / `--system-prompt` text as `options.customSystemPrompt` and resolved `APPEND_SYSTEM.md` / `--append-system-prompt` text as `options.appendSystemPrompt` via `applyResolvedSystemPromptInputs` in `packages/coding-agent/src/main.ts`. These flow into `buildSystemPrompt` as `resolvedCustomPrompt` and `resolvedAppendSystemPrompt`.

`buildSystemPrompt` assembles four ordered zones:

1. **Runtime** — conventions, tools, tool policy, skills, rules, MCP/internal protocols, and tool-specific safety. Harness-owned and always preserved.
2. **System** — role, personality, behavior, workflow, and delivery contract. The bundled default is replaced as a unit by a custom prompt.
3. **Append** — optional user text appended after the selected default/custom System.
4. **Project** — workstation, cwd, context files, directory rules, workspace tree, date, and repository context. Dynamically rendered and always preserved.

`system-prompt.md` is the unified Runtime/System/Append template. Its `{{#if customPrompt}}` branch selects custom text; the `{{else}}` branch renders the bundled System behavior. `project-prompt.md` renders the Project zone as a subsequent provider-facing block.

Consequences:

- `SYSTEM.md` replaces default model behavior, not harness capabilities.
- Tool inventory, tool policy, skills, rules, MCP protocols, and tool-specific safety remain available with custom prompts.
- `APPEND_SYSTEM.md` follows the selected System zone and appears exactly once.
- Project/environment context remains after default, custom, and append content.
- Subagent prompts use the same custom-System path, replacing the main-agent role/workflow without losing Runtime or Project.

When a custom prompt is provided, `callerControlsCustomPrompt` suppresses the secondary capability discovery path. This prevents a second `SYSTEM.md` from being loaded or injected.

- To add a few instructions while retaining the complete default prompt, use only `APPEND_SYSTEM.md` or `--append-system-prompt`.
- To replace the default instruction template while retaining generated project context, skills, and rules, use `SYSTEM.md` or `--system-prompt`.
- If a custom prompt still needs the default tool policy or workflow, copy and maintain the required guidance yourself; selective inheritance from `system-prompt.md` is not supported.

### Append placement

Without `SYSTEM.md`, append text is rendered at the end of `project-prompt.md`, after the default instruction block and project/environment content.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. A `{{value}}` reference in Handlebars still does not recursively render its substituted contents — the value is emitted as a string. Concretely:

```handlebars
{{! The custom prompt is emitted verbatim inside the template }}
{{#if customPrompt}}
{{customPrompt}}
{{/if}}
```

SDK-generated append content (for enabled memory/auto-learn features and MCP guidance) is combined before the user-supplied append text.

## Plain-text contract

`SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are plain text. They are values inserted into bundled Handlebars templates; their contents are not recursively compiled as Handlebars.

For example, if `SYSTEM.md` contains:

```handlebars
Working in
{{cwd}}
on
{{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

those characters reach the model literally. Internal values such as `cwd`, `skills`, `rules`, and `toolRefs` are private template implementation details, not a user templating API. The calendar date is deliberately not exposed as a template value anymore — it rides the per-request first-turn reminder instead (see above).

## Recipes

### Add rules to the default prompt

---

## 4) Recommended patterns

### Add rules without replacing default behavior

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. Runtime, the bundled System behavior, and Project remain intact.

```text
# ~/.omp/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### Replace model behavior while keeping harness capabilities

Use `SYSTEM.md` (or `--system-prompt`). This replaces the bundled role, personality, workflow, and delivery contract. Runtime still supplies generated tool guidance, skills, rules, MCP/internal protocols, and tool-specific safety; Project still supplies environment and repository context.

```text
# <cwd>/.omp/SYSTEM.md
You are a code reviewer. Read changes, surface concrete issues, and never edit files.
Cite paths with backticks.
```

Use `APPEND_SYSTEM.md` alongside it when a separate final supplement should follow the custom behavior.

### Customize automatic session titles

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect title-generation calls. Use `TITLE_SYSTEM.md`:

```text
# ~/.omp/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message has no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` uses the same project-first, config-base discovery and no-ancestor-walk behavior. When absent, OMP uses its bundled title prompt. The override is used for both initial automatic titles and replan-driven title refreshes.

Generated title output has an enforced normalization contract even with a
custom prompt. OMP considers only the first trimmed line, strips surrounding
quotes, `<title>...</title>` markers, and terminal punctuation, and treats
`none` or `<title/>` as “no title yet.” A result longer than 80 characters or
12 words is rejected rather than truncated. Empty, deferred, or rejected output
leaves the session unnamed, so a later eligible title attempt can name it.

The normal CLI file/flag path preserves Runtime and Project. SDK code using `CreateAgentSessionOptions.systemPrompt` can replace the complete provider-facing prompt array and omit either zone; `.omp/SYSTEM.md`, `~/.omp/agent/SYSTEM.md`, and `--system-prompt` cannot.

`CreateAgentSessionOptions.systemPrompt` is a different, lower-level API. A string or array replaces the fully rendered default blocks; a callback receives the rendered block array and returns its replacement. This can omit all generated context and safety blocks.

There is no built-in way to inherit selected subsections of the bundled System behavior while replacing the rest. Use Append to retain the complete bundled System, or copy the required behavior into `SYSTEM.md`. Runtime remains available in both cases.

## Quick reference

## 5) Deduplication

When a CLI flag or discovered `SYSTEM.md` provides a custom System zone, `applyResolvedSystemPromptInputs` sets `options.customSystemPrompt`. `callerControlsCustomPrompt` then suppresses secondary capability discovery, so the same `SYSTEM.md` is not loaded twice.

Always-apply rules are deduplicated against the custom prompt, append prompt, and context files. A rule whose body is already present in one of those sources is omitted from Runtime injection.

---

## 6) Discovery paths

Only one path actually drives the customization a CLI user sees: the primary CLI path. The capability layer exists but its `SYSTEM.md` output never reaches the rendered prompt under normal CLI startup.

- The primary CLI path (`discoverSystemPromptFile` / `discoverAppendSystemPromptFile` in `main.ts`, which feeds `resolvedSystemPrompt` / `resolvedAppendPrompt`) calls `findConfigFile`. `findConfigFile` checks only `<cwd>/.omp`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents — it does **not** walk up ancestors. Files in `<ancestor>/.omp/SYSTEM.md` are ignored when `omp` is started from a subdirectory.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) does walk up via `findNearestProjectConfigDir` and requires the project `.omp/` directory to be non-empty. Under normal CLI startup, `callerControlsCustomPrompt` suppresses this path entirely when the primary path found a custom prompt.

Net effect for CLI users: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.omp` (or another supported config base under cwd) or in the user-level location (`~/.omp/agent/SYSTEM.md` etc.). Ancestor paths are not searched.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add instructions while keeping bundled model behavior | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace bundled model behavior while keeping Runtime and Project | `SYSTEM.md` or `--system-prompt` |
| Preserve generated skills/rules/tool guidance while customizing | `SYSTEM.md`; Runtime remains outside the replaceable System zone |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Inherit selected bundled System subsections | Not supported; use Append or copy the required behavior into `SYSTEM.md` |
| Override at a per-repo level | Project `.omp/SYSTEM.md` under the cwd you launch `omp` from |
| Override globally | `~/.omp/agent/SYSTEM.md` or `~/.omp/agent/APPEND_SYSTEM.md` |
