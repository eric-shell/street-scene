---
name: check
description: Verify the code - typecheck, then the Vitest suite - printing only failures and a one-line summary. Use after code changes, before committing, or when asked whether things pass. Arguments narrow the tests (a file, -t "name") or "tsc" for typecheck only.
argument-hint: [tests/file.test.ts] [-t name] | tsc
allowed-tools: Bash(.claude/skills/check/check.sh *)
---
Run from the project root (full suite is about 35 s, so give the Bash tool a 180000 ms timeout):

    .claude/skills/check/check.sh $ARGUMENTS

- Typecheck alone is about 1 s (`check.sh tsc`); one test file 2 to 15 s; `tests/ai.test.ts` and `tests/rails.test.ts` are the slow ones (many-seed sweeps).
- Fix the first failure, re-run the narrowest useful target, then run the full suite once before calling the work done.
- Report the script's output verbatim only when it shows failures; otherwise just state the summary line.
