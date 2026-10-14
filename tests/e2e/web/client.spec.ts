import { TempoError } from "@tempo/protocol";
import { test, expect } from "./fixture";
import { pressMod } from "../platform";

test.beforeEach(async ({ page, fixture }) => {
  expect(fixture.workspace.id).toBe("w1");
  await page.goto("/w/w1");
  await expect(page.locator("#root > div").first()).toHaveCSS("height", `${page.viewportSize()!.height}px`, {
    timeout: 15_000,
  });
});

test("a pending send survives tab switches and restores its draft after failure", async ({
  page,
  fixture,
}) => {
  let release!: () => void;
  fixture.hold.set(
    "sendPrompt",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  fixture.failures.set("sendPrompt", new TempoError("TEMPOD_UNREACHABLE"));
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Restore this on failure");
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(1);

  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  release();
  await expect(page.getByText("Lost contact with the workspace. Reconnecting.")).toBeVisible();
  await page.getByRole("tab", { name: "Claude chat", exact: true }).click();
  await expect(message).toHaveValue("Restore this on failure");
  expect(fixture.inputs("sendPrompt")).toHaveLength(1);
});

test("mentions, slash plan mode and file uploads reach the prompt contract", async ({ page, fixture }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("@README");
  await expect(page.getByRole("option", { name: "README.md", exact: true })).toBeVisible();
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Remove README.md" })).toBeVisible();
  await message.fill("/plan");
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("setSessionMode").at(-1)?.modeId).toBe("plan");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") });
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();

  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeHidden();
  await page.getByRole("tab", { name: "Claude chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove README.md" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
  await message.fill("Review this");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(1);
  expect(fixture.inputs("sendPrompt")[0]).toMatchObject({
    text: "Review this",
    mentions: [{ path: "README.md" }],
    attachmentIds: ["attachment-1"],
  });
});

test("git primary action advances from commit through PR, merge and archive", async ({ page, fixture }) => {
  const primary = page.locator("header").first();

  await primary.getByRole("button", { name: "Commit and push" }).click();
  await page.getByRole("textbox", { name: "Commit message" }).last().fill("Document keeled");
  await page.getByRole("button", { name: "Commit and push", exact: true }).last().click();
  await expect.poll(() => fixture.inputs("commitAndPush").length).toBe(1);
  expect(fixture.inputs("commitAndPush")[0]?.message).toBe("Document keeled");
  await primary.getByRole("button", { name: "Create PR", exact: true }).click();
  await expect.poll(() => fixture.inputs("createPullRequest").length).toBe(1);
  await primary.getByRole("button", { name: "Merge", exact: true }).click();
  await expect.poll(() => fixture.inputs("mergePullRequest").length).toBe(1);
  expect(fixture.inputs("mergePullRequest")[0]?.method).toBe("squash");
  await primary.getByRole("button", { name: "Archive", exact: true }).click();
  await expect.poll(() => fixture.inputs("archiveWorkspace").length).toBe(1);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(() => fixture.inputs("restoreWorkspace").length).toBe(1);
});

test("sleep and archive expose the correct read-only and restore states", async ({ page, fixture }) => {
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  fixture.updateWorkspace({ state: "sleeping" });
  await expect(page.getByRole("button", { name: "Sleeping", exact: true })).toBeVisible();
  await expect(page.getByPlaceholder(/to wake this workspace$/)).toBeVisible();
  await expect(page.getByText("Sleeping. Sending a message wakes it.")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Wake and continue");
  await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(1);
  fixture.updateWorkspace({ state: "archived", archivedAt: 2000 });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Restore to continue" }).click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
});

test("desktop shortcuts, settings, live scripts and terminal", async ({ page, fixture }) => {
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await pressMod(page, "k");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+Comma");
  await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await expect(page.getByText("Theme", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Alt+r");
  await expect.poll(() => fixture.inputs("runScript").length).toBe(1);
  await expect(page.getByText("Ready on port 3000", { exact: false })).toBeVisible();
  await page.keyboard.press("Alt+r");
  await expect.poll(() => fixture.inputs("stopScript").length).toBe(1);
  await page.getByRole("button", { name: "New tool tab" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".xterm-screen")).toBeVisible();
  await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
  await page.keyboard.type("ls");
  await page.keyboard.press("Enter");
  await expect.poll(() => fixture.terminalInput).toBe("ls\r");
  await page.getByRole("button", { name: "New tool tab" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
  await page.getByRole("tab", { name: "Terminal 1", exact: true }).click();
  await expect(page.locator(".xterm-helper-textarea:visible")).toBeFocused();
  await expect(page.locator(".xterm-screen")).toHaveCount(2);
});

test(
  "phone navigation opens unified diffs and returns to the composer",
  { tag: "@mobile" },
  async ({ page }) => {
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Changes" }).tap();
    await expect(page.getByRole("button", { name: "Commit and push" })).toBeVisible();
    await page.getByRole("option", { name: /README.md/ }).tap();
    await expect(page.getByText("new README", { exact: false })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Switch tab" }).tap();
    await page.getByRole("menuitem", { name: "Claude chat", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Switch tab" })).toBeFocused();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
    await page
      .getByRole("navigation", { name: "Sections" })
      .getByRole("button", { name: "Workspaces" })
      .tap();
    await expect(page.getByRole("link", { name: /Build keeled/ })).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).tap();
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Appearance", exact: true }).tap();
    await page.getByRole("radio", { name: "Dark", exact: true }).tap();
    await expect(page.locator("html")).toHaveCSS("color-scheme", "dark");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole("button", { name: "Back", exact: true }).tap();
    await expect(page.getByRole("link", { name: /Build keeled/ })).toBeVisible();
    await page.getByRole("link", { name: /Build keeled/ }).tap();
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  },
);

test("theme follows the selected appearance and persists across reloads", async ({ page }) => {
  const root = page.locator("html");
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.keyboard.press("Alt+Comma");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Dark", exact: true }).click();
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.reload();
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.keyboard.press("Alt+Comma");
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByRole("radio", { name: "Light", exact: true }).click();
  await expect(root).toHaveCSS("color-scheme", "light");
  await page.getByRole("radio", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(root).toHaveCSS("color-scheme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(root).toHaveCSS("color-scheme", "light");
});

test("tool tabs keep the chat and draft visible beside files and Browser Run", async ({ page, fixture }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Keep this draft");
  await page.getByRole("button", { name: "Toggle right side", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Workspace info", exact: true }).click();
  await page.getByRole("button", { name: /^Changes\b/ }).click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await page.getByRole("treeitem", { name: "README.md", exact: true }).click();
  await expect(page.getByText("export const keeled = true;", { exact: false })).toBeVisible();
  await expect(message).toHaveValue("Keep this draft");
  await expect(
    page.getByRole("region", { name: "Chat", exact: true }).getByRole("tab", { name: "README.md" }),
  ).toHaveCount(0);
  fixture.liveViewUrl = "https://browser.fixture.test/live";
  await page.route("https://browser.fixture.test/live", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Browser Run fixture</p>" }),
  );
  fixture.updateWorkspace({ browserActive: true });
  await page.getByRole("button", { name: "New tool tab" }).click();
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(page.frameLocator('iframe[title="Live View"]').getByText("Browser Run fixture")).toBeVisible();
  await expect(message).toHaveValue("Keep this draft");
  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  await expect(message).toHaveValue("");
  await expect(page.getByRole("tab", { name: "Browser", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("button", { name: "Close tool tab" }).last().click();
  await expect(page.getByRole("heading", { name: "Tools", exact: true })).toBeVisible();
  await expect(message).toBeVisible();
});
