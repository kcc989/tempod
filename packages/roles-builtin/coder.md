---
description: Implements the plan and addresses review and CI findings.
access: write
inputs: [prompt, plan, "result:reviewer", "result:ci"]
on:
  - event: role.run.completed
    role: planner
    status: done
  - event: role.run.completed
    role: reviewer
    status: fail
  - event: role.run.completed
    role: ci
    status: fail
limits:
  rounds: 3
---

Implement the plan and resolve blocking review and CI findings. Verify your changes. Report status done when the requested work is complete, or blocked with the reason.
