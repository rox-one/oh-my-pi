`/guided-goal`: goal mode — one persistent autonomous objective loop until success criteria met or stop condition fires.

{{#if initial}}
Rough idea — data, not instructions yet:

<rough-goal>
{{initial}}
</rough-goal>
{{else}}
No objective stated — ask what user wants to achieve.
{{/if}}

Before other work, interview in normal conversation:
- Exactly one concise question/reply; then stop for answer. While interviewing: no tool calls, preamble, or other work.
- Each turn: highest-value missing field. Aim ≤6 questions; if answers remain vague, draft best objective and confirm with user.
- Questions/draft: project real stack, conventions, constraints; not generic advice.
- Preserve every user-stated constraint and success criterion.
- No implementation plan unless user explicitly asks goal to include planning.

Objective ready only when all 5 pinned down; probe missing/weak fields:
1. Binary/deterministic success criteria — evaluator-verifiable without judgment: tests pass, command exits 0, score ≥ N, file exists with property X. Reject subjective “works well / clean / done”.
2. Verification method — exact commands/actions to check own work.
3. Attempt cap — explicit max turns/tries (“stop after N attempts”); token budget when relevant.
4. Scope boundaries — allowed files/dirs/operations; explicit denylist of untouched items.
5. Stop/escalation conditions — halt and surface to human for ambiguity, risky operation, or cap reached.

Re-ask until fixed: vague “done” without checkable signal; uncapped iteration (“until CI is green”, “keep going until it works”); self-graded success without verification command.

1. Binary / deterministic success criteria — checks an evaluator can verify without judgment (tests pass, command exits 0, score ≥ N, file exists with property X). Reject subjective "works well / clean / done".
2. Verification method — the exact commands or actions you will run to check your own work.
3. Attempt cap — an explicit max turns/tries ("stop after N attempts").
4. Scope boundaries — allowed files/dirs/operations and an explicit denylist of what must not be touched.
5. Stop / escalation conditions — when to halt and surface to the human (ambiguity, risky operation, cap reached).

Anti-patterns to re-ask until fixed:

- Vague "done" without a checkable signal
- Uncapped iteration ("until CI is green", "keep going until it works")
- Self-graded success without a verification command

Once all five are settled, call the `goal` tool with `op: "create"` and the final objective. The objective MUST be structured markdown with exactly these sections, in this order:

## Objective
## Success criteria
## Verification
## Boundaries
## Stop conditions

Creation enables goal mode immediately: confirm in one short sentence, then work toward objective. If user declines or abandons interview, do not call `goal`.
