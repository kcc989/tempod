import { afterEach, expect, it, vi } from "vitest";
import { createMermaidRenderer } from "~/ui/components/chat/mermaid";

const setup = () => {
  const initialize = vi.fn();
  const render = vi.fn(async () => ({ svg: "<svg/>" }));
  const load = vi.fn(async () => ({ initialize, render }));

  return { initialize, render, load, renderMermaid: createMermaidRenderer(load) };
};

afterEach(() => vi.unstubAllEnvs());

it("keeps browser diagram dependencies out of server rendering", async () => {
  vi.stubEnv("SSR", true);
  const api = setup();
  await expect(api.renderMermaid("graph TD; A-->B", false)).rejects.toThrow("browser");
  expect(api.load).not.toHaveBeenCalled();
  expect(api.render).not.toHaveBeenCalled();
});

it("loads diagrams in the browser with strict security and theme settings", async () => {
  vi.stubEnv("SSR", false);
  const api = setup();
  await expect(api.renderMermaid("graph TD; A-->B", true)).resolves.toMatch(/^data:image\/svg\+xml/);
  expect(api.load).toHaveBeenCalledOnce();
  expect(api.initialize).toHaveBeenCalledWith({
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    theme: "dark",
  });
  expect(api.render).toHaveBeenCalledWith("tempo-mermaid-1", "graph TD; A-->B");
});
