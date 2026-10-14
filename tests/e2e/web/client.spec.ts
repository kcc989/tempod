import { TempoError, type Item } from "@tempo/protocol";
import { test, expect } from "./fixture";
import { pressMod } from "../platform";

test.beforeEach(async ({ page, fixture }) => {
  expect(fixture.workspace.id).toBe("w1");
  await page.goto("/w/w1");
  await expect(page.locator("#root > div").first()).toHaveCSS("height", `${page.viewportSize()!.height}px`, {
    timeout: 15_000,
  });
});

test(
  "renders live workspace state and keeps chat drafts across tabs and reloads",
  { tag: "@mobile" },
  async ({ page, fixture }) => {
    await expect(page.getByRole("heading", { name: "Build keeled" })).toBeVisible();
    await expect(
      page.getByLabel("Transcript", { exact: true }).getByText("Ready to review keeled."),
    ).toBeVisible();
    const message = page.getByRole("textbox", { name: "Message", exact: true });
    await message.fill("Draft for Claude");

    if (test.info().project.name.startsWith("phone")) {
      await page.getByRole("button", { name: "Switch tab" }).click();
      await page.getByRole("menuitem", { name: "Second chat" }).click();
    } else await page.getByRole("tab", { name: "Second chat", exact: true }).click();
    await expect(message).toHaveValue("");
    await message.fill("Other draft");
    await page.reload();
    await expect(message).toHaveValue("Draft for Claude");
    fixture.updateWorkspace({ title: "Keeled ready" });
    await expect(page.getByRole("heading", { name: "Keeled ready" })).toBeVisible();
  },
);

test("sends, queues, edits queued prompts and stops through the real composer", async ({ page, fixture }) => {
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("First prompt");
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(1);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(message).toHaveValue("");
  await message.fill("Next prompt");
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Next prompt", exact: true })).toBeVisible();
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(2);
  expect(fixture.inputs("sendPrompt").map((i) => i.delivery)).toEqual(["queue", "queue"]);
  await page.getByRole("button", { name: "Next prompt", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit queued message" }).fill("Updated next prompt");
  await page.getByRole("textbox", { name: "Edit queued message" }).press("Enter");
  await expect.poll(() => fixture.inputs("editQueuedTurn").at(-1)?.text).toBe("Updated next prompt");
  await expect(page.getByRole("button", { name: "Updated next prompt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => fixture.inputs("cancelTurn").length).toBe(1);
});

test("restores failed sends and prevents duplicate pending keyboard submissions", async ({
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
  await message.fill("Keep this prompt");
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").length).toBe(1);
  await message.fill("New draft while sending");
  await message.press("Enter");
  release();
  await expect(page.getByText("Lost contact with the workspace. Reconnecting.")).toBeVisible();
  await expect(message).toHaveValue("New draft while sending");
  expect(fixture.inputs("sendPrompt")).toHaveLength(1);
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

  if (test.info().project.name.startsWith("phone")) {
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.getByRole("menuitem", { name: "Second chat" }).click();
  } else await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  release();
  await expect(page.getByText("Lost contact with the workspace. Reconnecting.")).toBeVisible();

  if (test.info().project.name.startsWith("phone")) {
    await page.getByRole("button", { name: "Switch tab" }).click();
    await page.getByRole("menuitem", { name: "Claude chat" }).click();
  } else await page.getByRole("tab", { name: "Claude chat", exact: true }).click();
  await expect(message).toHaveValue("Restore this on failure");
  expect(fixture.inputs("sendPrompt")).toHaveLength(1);
});

test(
  "mentions, slash plan mode and file uploads reach the prompt contract",
  { tag: "@mobile" },
  async ({ page, fixture }) => {
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

    if (test.info().project.name.startsWith("phone")) {
      await page.getByRole("button", { name: "Switch tab" }).click();
      await page.getByRole("menuitem", { name: "Second chat" }).click();
      await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeHidden();
      await page.getByRole("button", { name: "Switch tab" }).click();
      await page.getByRole("menuitem", { name: "Claude chat" }).click();
    } else {
      await page.getByRole("tab", { name: "Second chat", exact: true }).click();
      await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeHidden();
      await page.getByRole("tab", { name: "Claude chat", exact: true }).click();
    }

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
  },
);

test("announces completed live messages once and leaves the historical backlog quiet", async ({
  page,
  fixture,
}) => {
  await expect(page.getByLabel("Transcript", { exact: true })).toBeVisible();
  const announcement = page.locator('section[aria-label="Chat"] [aria-live="polite"].sr-only');
  await expect(announcement).toHaveText("");

  const message: Item = {
    id: "live-message",
    sessionId: "s1",
    turnId: "t1",
    kind: "agent_message",
    status: "streaming",
    content: { text: "Live response" },
    rev: 3,
    createdAt: 3000,
    updatedAt: 3000,
  };

  fixture.emit({ type: "item.upsert", item: message, itemsRev: 3 });
  await expect(announcement).toHaveText("");
  fixture.emit({ type: "item.upsert", item: { ...message, status: "completed", rev: 4 }, itemsRev: 4 });
  await expect(announcement).toHaveText("Live response");
  fixture.emit({
    type: "item.upsert",
    item: { ...message, status: "completed", content: { text: "Duplicate completion" }, rev: 5 },
    itemsRev: 5,
  });
  await expect(announcement).toHaveText("Live response");
});

test(
  "new workspace uses the selected project, discovered model and text prompt",
  { tag: "@mobile" },
  async ({ page, fixture }) => {
    await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();

    if (test.info().project.name.startsWith("phone")) {
      await page
        .getByRole("navigation", { name: "Sections" })
        .getByRole("button", { name: "Workspaces" })
        .click();
      await page.getByRole("button", { name: "New workspace in kcc989/keeled" }).click();
    } else await page.keyboard.press("Alt+n");
    const dialog = page.getByRole("dialog", { name: "New workspace" });
    await expect(dialog).toBeVisible();
    const prompt = dialog.getByRole("textbox", { name: "Prompt", exact: true });
    await expect(prompt).toBeFocused();
    await prompt.fill("Update keeled documentation");
    await dialog.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Fixture Sonnet · Claude", exact: true }).click();
    await dialog.getByRole("button", { name: /^Create/ }).click();
    await expect.poll(() => fixture.inputs("createWorkspace").length).toBe(1);
    expect(fixture.inputs("createWorkspace")[0]).toMatchObject({
      projectId: "p1",
      agent: "claude",
      model: "fixture-sonnet",
      source: { kind: "new", baseBranch: "main" },
      prompt: { text: "Update keeled documentation" },
    });
    await expect(dialog).toBeHidden();
  },
);

test("git primary action advances from commit through PR, merge and archive", async ({ page, fixture }) => {
  if (test.info().project.name.startsWith("phone")) {
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Changes" }).click();
  }

  const primary = test.info().project.name.startsWith("phone")
    ? page.getByRole("region", { name: "Changes", exact: true })
    : page.locator("header").first();

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

test("permission keyboard replies close the live card", async ({ page, fixture }) => {
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();

  const permission: Item = {
    id: "permission-item",
    sessionId: "s1",
    turnId: "t1",
    kind: "permission",
    status: "pending",
    rev: 3,
    createdAt: 1000,
    updatedAt: 1000,
    content: {
      requestId: "request-1",
      title: "Write README",
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject once", kind: "reject_once" },
      ],
    },
  };

  fixture.items.push(permission);
  fixture.emit({ type: "item.upsert", item: permission, itemsRev: 3 });
  const card = page.getByRole("group", { name: "Permission: Write README" });
  const allow = card.getByRole("button", { name: /^Allow once/ });
  await card.focus();
  await card.press("Enter");
  await expect.poll(() => fixture.inputs("respondPermission").at(-1)?.optionId).toBe("allow");
  await expect(allow).toBeHidden();
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

test("desktop review, comments and file navigation", async ({ page, fixture }) => {
  test.skip(test.info().project.name.startsWith("phone"), "phone review has its own flow");
  await page.getByRole("button", { name: /^Changes\b/ }).click();
  await page.getByRole("option", { name: /README.md/ }).click();
  await expect(page.getByText("new README", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: /Comment on file/ }).click();
  await page.getByPlaceholder("Add a comment").fill("Clarify the setup instructions");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await expect(page.getByText("Clarify the setup instructions", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send 1 comment to Claude" }).click();
  await expect(page.getByText("1 review comment", { exact: true })).toBeVisible();
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Apply the review");
  await message.press("Enter");
  await expect.poll(() => fixture.inputs("sendPrompt").at(-1)?.reviewCommentIds).toEqual(["comment-1"]);
  await pressMod(page, "p");
  await page.getByRole("combobox", { name: "File name" }).fill("main");
  await page.getByRole("option", { name: /main.ts/ }).click();
  await expect(page.getByText("export const keeled = true;", { exact: false })).toBeVisible();
});

test("desktop shortcuts, settings, live scripts and terminal", async ({ page, fixture }) => {
  test.skip(test.info().project.name.startsWith("phone"), "desktop panels");
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
  await expect(page.getByRole("button", { name: /New terminal/ })).toBeVisible();
  await expect(page.locator(".xterm-screen")).toBeVisible();
});

test(
  "phone navigation opens unified diffs and returns to the composer",
  { tag: "@mobile" },
  async ({ page }) => {
    test.skip(!test.info().project.name.startsWith("phone"), "phone navigation");
    await page.getByRole("navigation", { name: "Sections" }).getByRole("button", { name: "Changes" }).tap();
    await expect(page.getByRole("button", { name: "Commit and push" })).toBeVisible();
    await page.getByRole("option", { name: /README.md/ }).tap();
    await expect(page.getByText("new README", { exact: false })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Switch tab" }).tap();
    await page.getByRole("menuitem", { name: "Claude chat", exact: true }).tap();
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
  await expect(root).toHaveCSS(
    "color-scheme",
    test.info().project.use.colorScheme === "dark" ? "dark" : "light",
  );
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
  await page.getByRole("button", { name: "Changes", exact: true }).click();
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
