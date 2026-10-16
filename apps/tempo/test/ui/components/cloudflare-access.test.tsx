import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { CloudflareAccessContent } from "@tempo/protocol";
import { expect, it } from "vitest";
import { CloudflareAccessCard } from "../../../src/ui/components/chat/CloudflareAccessCard";

const access: CloudflareAccessContent = {
  requestId: "r1",
  permissions: ["d1", "routes"],
  reason: "The todo app needs a database and a custom domain.",
  status: "pending",
};

it("shows each permission with its Cloudflare groups and the reason, and approves with one action (12)", async () => {
  environment.request.mockResolvedValue({});

  const { rerender } = render(<CloudflareAccessCard workspaceId="w1" access={access} writable />, {
    wrapper: environment.Provider,
  });

  const card = screen.getByRole("region", { name: "Cloudflare access request" });
  expect(card.textContent).toContain("Write D1 databases · D1 Write");
  expect(card.textContent).toContain(
    "Write Workers routes and DNS · Workers Routes Write, DNS Write, Zone Read",
  );
  expect(card.textContent).toContain("Reason: The todo app needs a database and a custom domain.");

  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  await waitFor(() =>
    expect(environment.request).toHaveBeenCalledWith("decideCloudflareAccess", {
      workspaceId: "w1",
      requestId: "r1",
      approve: true,
    }),
  );

  rerender(<CloudflareAccessCard workspaceId="w1" access={{ ...access, status: "denied" }} writable />);
  expect(screen.getByRole("region", { name: "Cloudflare access request" }).textContent).toContain(
    "Cloudflare access denied",
  );
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});
