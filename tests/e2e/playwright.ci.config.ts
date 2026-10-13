import { defineConfig } from "@playwright/test";
import browser from "./playwright.browser.config";
import web from "./playwright.web.config";

export default defineConfig({
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: "list",
  projects: [
    ...(web.projects ?? []).map((project) => ({
      ...project,
      testDir: web.testDir,
      outputDir: web.outputDir,
      timeout: web.timeout,
      expect: web.expect,
      use: { ...web.use, ...project.use },
    })),
    ...(browser.projects ?? []).map((project) => ({
      ...project,
      name: project.name === "phone-chromium" ? "browser-phone-chromium" : project.name,
      testDir: browser.testDir,
      outputDir: browser.outputDir,
      timeout: browser.timeout,
      expect: browser.expect,
      use: { ...browser.use, ...project.use },
    })),
  ],
  webServer: [web.webServer, browser.webServer].flat().filter((server) => server !== undefined),
});
