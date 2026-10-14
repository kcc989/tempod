import { createUiEnvironment } from "../environment";

const environment = createUiEnvironment();

const call = environment.request;

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TempoError } from "@tempo/protocol";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDeviceLogin } from "../../../src/ui/components/dialogs/settings/LoginsTab";

const setup = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  const invalidate = vi.spyOn(queryClient, "invalidateQueries");

  const view = render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(CodexDeviceLogin, { replacing: false }),
    ),
    { wrapper: environment.Provider },
  );

  const login = {
    loginId: "login-1",
    verificationUrl: "https://auth.openai.com/codex/device",
    userCode: "ABCD-EFGH",
    intervalMs: 1000,
    expiresAt: Date.now() + 900_000,
  };

  return { ...view, login, invalidate };
};

afterEach(() => vi.useRealTimers());

describe("Codex device login controls", () => {
  it("shows the link and code, polls to approval and refreshes credential status", async () => {
    const h = setup();
    vi.mocked(call).mockResolvedValueOnce(h.login);
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    await screen.findByText("ABCD-EFGH");
    expect(screen.getByRole("link", { name: "Open sign-in page" }).getAttribute("href")).toBe(
      h.login.verificationUrl,
    );
    vi.mocked(call)
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValueOnce({ status: "connected" });
    await waitFor(() => expect(call).toHaveBeenCalledWith("pollCodexLogin", { loginId: "login-1" }), {
      timeout: 2000,
    });
    await waitFor(
      () => expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ["call", "getCredentialStatus"] }),
      { timeout: 3000 },
    );
    expect(screen.queryByText("ABCD-EFGH")).toBeNull();
  });

  it("cancels and stops polling after the view closes", async () => {
    const h = setup();
    vi.mocked(call).mockResolvedValueOnce(h.login).mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    await screen.findByText("ABCD-EFGH");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByRole("button", { name: "Connect Codex" });
    expect(call).toHaveBeenCalledWith("cancelCodexLogin", { loginId: "login-1" });
    h.unmount();
    vi.useFakeTimers();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("shows expiry and disabled-login errors with a way to retry", async () => {
    const h = setup();
    vi.mocked(call).mockResolvedValueOnce({ ...h.login, expiresAt: Date.now() - 1 });
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    await screen.findByText("ABCD-EFGH");
    await screen.findByRole("alert", {}, { timeout: 2000 });
    expect(screen.getByRole("alert").textContent).toContain("expired");
    expect(call).toHaveBeenCalledTimes(1);
    vi.mocked(call).mockRejectedValueOnce(
      new TempoError("CREDENTIAL_INVALID", "Enable device-code login in ChatGPT."),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect Codex" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Enable device-code"));
  });
});
