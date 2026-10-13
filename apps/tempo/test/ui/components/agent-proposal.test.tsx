import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Schema } from "effect";
import { AgentProposalRecord } from "@tempo/protocol";
import fixture from "../../../../../packages/protocol/fixtures/types/AgentProposalRecord.jsonl?raw";
import { expect, it } from "vitest";
import { AgentProposalCard } from "../../../src/ui/components/chat/AgentProposalCard";
import { emptyWorkspaceState } from "../../../src/ui/stores/workspace-state";
import { detail } from "../fixtures";

const proposal = Schema.decodeUnknownSync(AgentProposalRecord)(JSON.parse(fixture.trim()));

it("shows the complete proposed definition and wiring, waits for owner apply or reject, then disables resolved cards", async () => {
  const second = {
    ...proposal,
    id: "second",
    proposal: { ...proposal.proposal, note: "Reject this change" },
  };

  const records = [proposal, second];
  const state = () => ({ ...emptyWorkspaceState, workspace: detail({ agentProposals: records }) });
  environment.setState(state());
  environment.request.mockImplementation(async (name, input) => {
    if (name === "resolveAgentProposal") {
      const choice = Schema.decodeUnknownSync(
        Schema.Struct({ proposalId: Schema.String, apply: Schema.Boolean }),
      )(input);

      const index = records.findIndex((p) => p.id === choice.proposalId);
      records[index] = { ...records[index]!, status: choice.apply ? "applied" : "rejected" };
      environment.setState(state());
    }

    return {};
  });
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AgentProposalCard workspaceId="proposal-w" proposalId={proposal.id} writable />
      <AgentProposalCard workspaceId="proposal-w" proposalId="second" writable />
    </QueryClientProvider>,
    { wrapper: environment.Provider },
  );
  const cards = screen.getAllByRole("region", { name: "Agent proposal" });
  expect(within(cards[0]!).getByLabelText("Proposed changes").textContent).toBe(
    JSON.stringify(proposal.proposal, null, 2),
  );
  expect(environment.request).not.toHaveBeenCalledWith("resolveAgentProposal", expect.anything());
  fireEvent.click(within(cards[0]!).getByRole("button", { name: "Apply" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("resolveAgentProposal", {
      workspaceId: "proposal-w",
      proposalId: proposal.id,
      apply: true,
    }),
  );
  await screen.findByText("Agent changes · applied");
  expect(within(cards[0]!).queryByRole("button", { name: "Apply" })).toBeNull();
  fireEvent.click(within(cards[1]!).getByRole("button", { name: "Reject" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("resolveAgentProposal", {
      workspaceId: "proposal-w",
      proposalId: "second",
      apply: false,
    }),
  );
  await screen.findByText("Agent changes · rejected");
  expect(within(cards[1]!).queryByRole("button", { name: "Apply" })).toBeNull();
});
