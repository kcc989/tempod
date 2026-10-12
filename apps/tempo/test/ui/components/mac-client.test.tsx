import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { expect, it, vi } from "vitest";
import { MacClientInfo } from "../../../src/ui/components/dialogs/settings/MacClientInfo";

const show = (latestMacClient: string | null) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ protocol: 1, serverVersion: "0.1.0", minMacClient: "0.1.0", latestMacClient }),
  );
  return render(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MacClientInfo)),
  );
};

it("uses the server's version and authenticated Mac download route", async () => {
  show("0.1.1");
  const link = await screen.findByRole("link", { name: "Download Tempo for Mac 0.1.1" });
  expect(link.getAttribute("href")).toBe("/downloads/mac/0.1.1");
  expect(screen.getByText(/Requires Tempo for Mac 0.1.0 or later/)).toBeTruthy();
});

it("shows the unpublished state without inventing a download", async () => {
  show(null);
  expect(await screen.findByText("No Mac download has been published yet.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});

it("does not make a link from an invalid published version", async () => {
  show("../../private");
  expect(await screen.findByText("No Mac download has been published yet.")).toBeTruthy();
  expect(screen.queryByRole("link")).toBeNull();
});
