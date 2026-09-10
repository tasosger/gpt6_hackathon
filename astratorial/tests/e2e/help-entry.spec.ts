import { expect, test } from "@playwright/test";

test("home goal survives reload, preserves the old draft until saved, and gates later steps", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: { configured: false, services: { database: false, openai: false, worker: false }, user: null } }));
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("astratorial-draft-v1", JSON.stringify({ version: 1, goal: "Repair my chair", constraints: "Only a screwdriver", title: "Old draft", referenceUrls: "" })));
  const goal = "Make espresso with my new machine";
  await page.getByLabel("I want to…").fill(goal);
  await page.getByRole("button", { name: "Get started", exact: true }).click();
  await expect(page).toHaveURL(/\/create$/);
  await expect(page.getByRole("heading", { name: "Show what you’re working with." })).toBeVisible();
  await expect(page.locator(".workflow-goal-summary")).toContainText(goal);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("astratorial-draft-v1")!).goal)).toBe("Repair my chair");
  await page.reload();
  await expect(page.locator(".workflow-goal-summary")).toContainText(goal);
  await expect(page.getByRole("button", { name: /Review the plan/ })).toBeDisabled();
  await expect(page.getByRole("button", { name: /Create your guide/ })).toBeDisabled();
  await page.getByRole("button", { name: "Edit goal", exact: true }).click();
  await expect(page.getByRole("textbox", { name: /Your goal/ })).toHaveValue(goal);
  await page.getByText("Add preferences or reference links", { exact: false }).click();
  await expect(page.getByRole("textbox", { name: /Anything we should know/ })).toHaveValue("");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("button", { name: "Draft saved", exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("astratorial-help-entry-v1"))).toBeNull();
  await page.reload();
  await expect(page.getByRole("textbox", { name: /Your goal/ })).toHaveValue(goal);
});
