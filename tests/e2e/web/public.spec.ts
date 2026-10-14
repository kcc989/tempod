import { test, expect } from "./fixture";

// 04, Public projects: /:namespace/:slug works without a session and never offers writes.
test("an anonymous visitor reads a public repository and is sent to sign in to star", async ({
  page,
  fixture,
}) => {
  await page.route("**/api/auth/get-session", (route) => route.fulfill({ json: null }));
  await page.goto("/acme/site");
  await expect(page.getByRole("heading", { name: "acme/site" })).toBeVisible();
  await expect(page.getByRole("button", { name: "README.md" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("button", { name: "New workspace" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Checks" })).toHaveCount(0);
  expect(fixture.inputs("getProject")).toEqual([{ namespace: "acme", slug: "site" }]);
  await page.getByRole("button", { name: /Star\s*3/ }).click();
  await expect(page).toHaveURL(/\/login\?redirect=%2Facme%2Fsite/);
});
