# Task system

How work moves from your head into shipped code.

## Files

- **`docs/tasks/<DD-MM-YYYY>.md`** — intake. You dump tasks freeform, any format.
  One-liners are fine.
- **`docs/tasks/backlog.md`** — the board. I pull each intake item in here,
  break it into subtasks, and attach improvement suggestions. This is the
  single source of truth for what's planned/approved/done.

## Flow

```
you write intake  →  I plan (subtasks + improvements)  →  you sign off  →  I build  →  done
      📥                        🔍 planned                      ✅ approved      🚧          ✔
```

## Status tags (in backlog.md)

| Tag | Meaning |
|-----|---------|
| 🔍 `planned` | Broken down, waiting on your sign-off. **I do not write code here.** |
| ✅ `approved` | You okayed it. Safe to implement. |
| 🚧 `in-progress` | Being built now. |
| ✔ `done` | Shipped + `pnpm check`/`build` green. |
| ❄️ `deferred` | Agreed to punt; reason noted. |

## Rules (yours)

1. Break every task into subtasks and discuss before implementing.
2. Suggest an improvement for each task before implementation.
3. Flag when one task overlaps another so we fix both in one pass.

## Pulling a task

When you say "start T3", I move it to 🚧, implement only its approved subtasks,
then flip to ✔ with a one-line result. If planning surfaces a conflict with a
settled decision, I stop and report before writing code.
