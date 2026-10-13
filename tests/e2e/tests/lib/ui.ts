import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E, NO_UI_REASON } from "./env.ts";

/**
 * Browser helpers. Selectors use only names and copy from 04 (UI), so they survive markup
 * changes: sidebar rows show the workspace title, permission cards have one button per option.
 */

export const requireUi = (): void => {
  test.skip(!E2E.storageState, NO_UI_REASON);
};

/** Opens the app and the workspace whose sidebar row shows `title`. */
export const openWorkspace = async (
  page: Page,
  title: string,
  opts: { phone?: boolean } = {},
): Promise<void> => {
  await page.goto("/");
  await expect(page.getByText("This Tempo belongs to someone else.")).toHaveCount(0);

  if (opts.phone) await page.getByText("Workspaces", { exact: true }).first().click();
  await page.getByText(title, { exact: true }).first().click();
};

/** The composer: the last text box of the chat pane. */
export const composer = (page: Page): Locator => page.getByRole("textbox").last();

export const sendFromComposer = async (page: Page, text: string): Promise<void> => {
  const box = composer(page);
  await box.click();
  await box.fill(text);
  await box.press("Enter");
};

/** Clicks the permission card button whose name is the option's name. */
export const choosePermission = async (page: Page, optionName: string): Promise<void> => {
  await page.getByRole("button", { name: optionName, exact: true }).first().click();
};
