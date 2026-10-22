---
name: check
description: Verify the code - typecheck, then the Vitest suite - printing only failures and a one-line summary. Use only when CLAUDE.md's Checks table calls for it (sim or city changes, a module with tests) or when asked whether things pass; most prompts need none. Arguments narrow the tests (a file, -t "name") or "tsc" for typecheck only.
argument-hint: [tests/file.test.ts] [-t name] | tsc
allowed-tools: Bash(.claude/skills/check/check.sh *)
---
Run from the project root (full suite is about 35 s, so give the Bash tool a 180000 ms timeout):

    .claude/skills/check/check.sh $ARGUMENTS

- Typecheck alone is about 1 s (`check.sh tsc`); one test file 2 to 15 s; `tests/ai.test.ts` and `tests/rails.test.ts` are the slow ones (many-seed sweeps).
- Fix the first failure, then re-run the narrowest useful target. Run the full suite once at the end only after a behaviour change in `src/sim/` or `src/city/`; typecheck alone covers most other code.
- Report the script's output verbatim only when it shows failures; otherwise just state the summary line.
