import type { AgentId, AgentModelOptions, ModelPick } from "@tempo/protocol";

/** Settings → Models (04): the owner's model list (01, Model list). Pure, so it is unit-tested. */
export interface ModelRow {
  readonly model: string;
  readonly name: string;
  readonly reported: boolean;
  readonly picked: boolean;
}

const samePick = (a: ModelPick, b: ModelPick): boolean => a.agent === b.agent && a.model === b.model;

/** Checking appends to the end of the list; unchecking removes the pick. */
export const togglePick = (picks: ReadonlyArray<ModelPick>, pick: ModelPick): ModelPick[] =>
  picks.some((p) => samePick(p, pick)) ? picks.filter((p) => !samePick(p, pick)) : [...picks, pick];

/** One column per agent with a login: reported models in order, then picks the agent no longer reports. */
export const modelColumns = (
  available: ReadonlyArray<AgentId>,
  reported: ReadonlyArray<AgentModelOptions>,
  picks: ReadonlyArray<ModelPick>,
): Array<{ readonly agent: AgentId; readonly rows: ModelRow[] }> =>
  available.map((agent) => {
    const options = reported.find((entry) => entry.agent === agent)?.options ?? [];
    const isPicked = (model: string) => picks.some((p) => samePick(p, { agent, model }));

    const rows = options.map((option) => ({
      model: option.value,
      name: option.name,
      reported: true,
      picked: isPicked(option.value),
    }));

    const missing = picks.flatMap((p) =>
      p.agent === agent && !options.some((option) => option.value === p.model)
        ? [{ model: p.model, name: p.model, reported: false, picked: true }]
        : [],
    );

    return { agent, rows: [...rows, ...missing] };
  });

/** A pick's reported name, else its model id. */
export const pickName = (pick: ModelPick, reported: ReadonlyArray<AgentModelOptions>): string =>
  reported.find((entry) => entry.agent === pick.agent)?.options.find((option) => option.value === pick.model)
    ?.name ?? pick.model;
