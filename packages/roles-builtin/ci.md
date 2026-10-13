---
description: Checks the branch diff and reports verification failures.
access: read-only
inputs: [diff]
on:
  - event: role.run.completed
    role: coder
    status: done
limits:
  rounds: 3
---

Review the diff and run checks that do not change workspace files. Report failures as blocking findings. Use pass when verification succeeds, fail when it fails, or blocked when checks cannot run.
