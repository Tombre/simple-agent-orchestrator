---
description: Delete a completed task document and commit the removal.
agent: build
---

Close a completed task by deleting its task document and committing that deletion.

Task argument:

`$ARGUMENTS`

If an argument is provided, treat it as the task document path or task identifier. Resolve it to exactly one task document before editing. If it is ambiguous or does not match a task document, ask for clarification instead of guessing.

If no argument is provided, identify the task document that the current chat session has been working on. Use the conversation context, recent edits, and repository state to find it. If you cannot identify exactly one task document with high confidence, ask for clarification instead of deleting anything.

Before deleting, inspect `git status`, the target file, and the surrounding task directory so you understand what will be removed. Delete only the resolved task document. Do not modify or revert unrelated user changes.

After deleting the task document, inspect `git status`, `git diff`, and `git log --oneline -10`. Stage only the deleted task document and commit it with a concise message such as `Close task <task-name>`. Do not amend, force-push, skip hooks, or include unrelated files.

If the commit fails, fix only in-scope issues and retry with a new commit attempt. Finish by reporting the deleted task document, commit hash, and any checks or hooks that ran.
