import type { AgentId, LifecycleEvent, RoleFile, RoleTrigger, Settings } from "@tempo/protocol";
export const matchTrigger = (trigger: RoleTrigger, event: LifecycleEvent): boolean => {
  if (trigger.event !== event.type) return false;
  if (
    "role" in trigger &&
    trigger.role !== undefined &&
    (!("role" in event.payload) || trigger.role !== event.payload.role)
  )
    return false;
  if ("status" in trigger && trigger.status !== undefined) {
    const status =
      event.type === "role.run.completed"
        ? event.payload.result.status
        : event.type === "agent.turn.ended"
          ? event.payload.status
          : undefined;
    if (trigger.status !== status) return false;
  }
  if (
    trigger.event === "agent.turn.ended" &&
    (trigger.session ?? "user") !== (event.roleRunId ? "role" : "user")
  )
    return false;
  return true;
};
export const chooseRoleAgent = (
  file: RoleFile,
  event: LifecycleEvent,
  settings: Settings,
  available: (agent: AgentId) => boolean,
): AgentId | null => {
  const qualifies = (agent: AgentId) =>
    available(agent) &&
    (!["pi", "opencode"].includes(agent) ||
      (file.model !== "default" ? !!file.model : !!settings.agent.models[agent]));
  if (file.agent === "other" && event.agent)
    return (
      ([settings.agent.default, "claude", "codex", "opencode", "pi"] as AgentId[]).find(
        (a) => a !== event.agent && qualifies(a),
      ) ?? null
    );
  const agent = file.agent === "auto" || file.agent === "other" ? settings.agent.default : file.agent;
  return qualifies(agent) ? agent : null;
};
