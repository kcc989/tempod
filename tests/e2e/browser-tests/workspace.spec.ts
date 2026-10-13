import { expect, test } from "@playwright/test";
import { browserFixture } from "./fixture";

test("streaming survives reload; Enter queues; Send now steers; permission answers work", async ({
  page,
}) => {
  const app = await browserFixture(page);
  await page.goto("/w/w1");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await expect(message).toBeVisible();
  await expect
    .poll(() =>
      page.getByRole("button", { name: "Queue", exact: true }).evaluate((el) => getComputedStyle(el).display),
    )
    .toBe("flex");
  app.stream(" Streamed live.");
  await expect(page.getByText("Starting the implementation. Streamed live.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Starting the implementation. Streamed live.")).toBeVisible();
  await message.fill("Do this later");
  await message.press("Enter");
  await expect(page.getByRole("button", { name: "Do this later", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Do this later", exact: true }).click();
  await page.getByRole("textbox", { name: "Edit queued message" }).fill("Updated queue");
  await page.getByRole("textbox", { name: "Edit queued message" }).press("Enter");
  await expect(page.getByRole("button", { name: "Updated queue", exact: true })).toBeVisible();
  await message.fill("Live guidance");
  await page.getByRole("button", { name: "Send now", exact: true }).click();
  await expect
    .poll(() => app.requests.filter((r) => r.name === "sendPrompt").map((r) => r.input["delivery"]))
    .toEqual(["queue", "steer"]);
  expect(app.requests.some((r) => r.name === "cancelTurn")).toBe(false);
  app.permission();
  await page.getByRole("button", { name: /Allow once/ }).click();
  await expect(page.getByText("Chose: Allow once")).toBeVisible();
});

test("file dialogs and Run shortcut remain available with the right side hidden", async ({ page }) => {
  const app = await browserFixture(page);
  await page.goto("/w/w1");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  const mod = await page.evaluate(() =>
    /mac|iphone|ipad|ipod/i.test(navigator.platform) || /Mac OS X/.test(navigator.userAgent)
      ? "Meta"
      : "Control",
  );
  await page.keyboard.press(`${mod}+Alt+b`);
  await expect(page.getByRole("tab", { name: "All files", exact: true })).toBeHidden();
  await page.keyboard.press(`${mod}+p`);
  await expect(page.getByRole("dialog", { name: "Open file" })).toBeVisible();
  await page.getByRole("combobox", { name: "File name" }).fill("main");
  await page.getByRole("option", { name: /main.ts/ }).click();
  await expect(page.getByText("Read only", { exact: true })).toBeVisible();
  await page.keyboard.press(`${mod}+Shift+f`);
  await expect(page.getByRole("dialog", { name: "Search files" })).toBeVisible();
  await page.getByRole("combobox", { name: "Search text" }).fill("ready");
  await expect(page.getByRole("option", { name: /export const ready/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Search files" })).toBeHidden();
  app.setRunScript();
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByRole("option", { name: /Start or stop the default run script/ })).toBeVisible();
  await expect(page.getByPlaceholder("Jump to a workspace or run an action")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeHidden();
  await page.keyboard.press("Alt+r");
  await expect
    .poll(() => app.requests.some((r) => r.name === "runScript" && r.input["scriptId"] === "dev"))
    .toBe(true);
});

test("draft mentions survive switching chats and a page reload", async ({ page }) => {
  const app = await browserFixture(page);
  await page.goto("/w/w1");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("@main");
  await page.getByRole("option", { name: "src/main.ts", exact: true }).click();
  await message.fill("Keep this draft");
  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  await message.fill("Second draft");
  await page.getByRole("tab", { name: "Working Chat", exact: true }).click();
  await expect(message).toHaveValue("Keep this draft");
  await page.reload();
  await expect(message).toHaveValue("Keep this draft");
  await message.press("Enter");
  await expect
    .poll(() => app.requests.find((r) => r.name === "sendPrompt")?.input["mentions"])
    .toEqual([{ path: "src/main.ts" }]);
});

test("phone layout reads, replies, approves, and reviews a unified diff without horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await browserFixture(page);
  await page.goto("/w/w1");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Phone reply");
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  app.permission();
  await page.getByRole("button", { name: /Allow once/ }).click();
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByRole("option").filter({ hasText: "main.ts" }).click();
  await expect(page.getByRole("radiogroup", { name: "Diff view" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Split", exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Comment on file", exact: true }).click();
  await page.getByRole("textbox", { name: "Whole file" }).fill("Review from phone");
  await page.getByRole("button", { name: "Add comment", exact: true }).click();
  await page.getByRole("button", { name: "Send 1 comment to Claude", exact: true }).click();
  await expect(page.getByText("1 review comment", { exact: true })).toBeVisible();
});

test("long transcripts retain their scroll position when switching chats", async ({ page }) => {
  const app = await browserFixture(page);
  app.longTranscript();
  await page.goto("/w/w1");
  const transcript = page.locator('[aria-label="Transcript"]');
  await expect(transcript).toBeVisible();
  await expect.poll(() => transcript.evaluate((el) => el.scrollHeight)).toBeGreaterThan(1000);
  await transcript.hover();
  await page.mouse.wheel(0, -600);
  await expect(page.getByRole("button", { name: "Jump to latest" })).toBeVisible();
  const savedTop = await transcript.evaluate((el) => el.scrollTop);
  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  await page.getByRole("tab", { name: "Working Chat", exact: true }).click();
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(savedTop);
  app.stream(" Later output.");
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(savedTop);
});

test("closed chats stay readable after confirming stop and close", async ({ page }) => {
  const app = await browserFixture(page);
  await page.goto("/w/w1");
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await page.keyboard.press("Alt+w");
  await expect(page.getByRole("alertdialog", { name: "Stop the agent and close this chat?" })).toBeVisible();
  await page.getByRole("button", { name: "Stop and close", exact: true }).click();
  await page.getByRole("button", { name: "Closed chats", exact: true }).click();
  await page.getByRole("menuitem", { name: /Chat/ }).click();
  await expect(page.getByText("This chat is closed.", { exact: true })).toBeVisible();
  await expect(page.getByText("Starting the implementation.", { exact: true })).toBeVisible();
  expect(app.requests.filter((r) => r.name === "cancelTurn")).toHaveLength(1);
});

test("blocked browser storage preserves composer typing", async ({ page }) => {
  await browserFixture(page);
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Storage blocked", "SecurityError");
    };
  });
  await page.goto("/w/w1");
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Typing with blocked storage");
  await expect(message).toHaveValue("Typing with blocked storage");
  await page.getByRole("tab", { name: "Second chat", exact: true }).click();
  await page.getByRole("tab", { name: "Working Chat", exact: true }).click();
  await expect(message).toHaveValue("Typing with blocked storage");
});
