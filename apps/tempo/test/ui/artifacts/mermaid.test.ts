import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  load: vi.fn(),
  initialize: vi.fn(),
  render: vi.fn().mockResolvedValue({ svg: "<svg/>" }),
}));
vi.mock("mermaid", () => {
  api.load();
  return { default: { initialize: api.initialize, render: api.render } };
});
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.unstubAllEnvs());

it("keeps browser diagram dependencies out of server rendering", async () => {
  vi.stubEnv("SSR", true);
  const { renderMermaid } = await import("~/ui/components/chat/mermaid");
  await expect(renderMermaid("graph TD; A-->B", false)).rejects.toThrow("browser");
  expect(api.load).not.toHaveBeenCalled();
  expect(api.render).not.toHaveBeenCalled();
});

it("loads diagrams in the browser with strict security and theme settings", async () => {
  vi.stubEnv("SSR", false);
  const { renderMermaid } = await import("~/ui/components/chat/mermaid");
  await expect(renderMermaid("graph TD; A-->B", true)).resolves.toMatch(/^data:image\/svg\+xml/);
  expect(api.load).toHaveBeenCalledOnce();
  expect(api.initialize).toHaveBeenCalledWith({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "dark",
  });
  expect(api.render).toHaveBeenCalledWith("tempo-mermaid-1", "graph TD; A-->B");
});
