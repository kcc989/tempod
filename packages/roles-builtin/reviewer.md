---
description: Reviews the branch diff against the plan and reports blocking issues.
agent: other
access: read-only
inputs: [diff, plan, "result:coder"]
requestable: true
on:
  - event: role.run.completed
    role: ci
    status: pass
limits:
  rounds: 3
---

Review the diff against the plan. Report each problem as a finding.
Mark a finding blocking when the change must not merge with it.
Set status pass when no finding is blocking, else fail.
