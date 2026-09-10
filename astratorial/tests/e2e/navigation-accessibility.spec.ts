import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: {
    configured: false,
    services: { database: false, openai: false, worker: false },
    user: null,
  } }));
});

test("the closed mobile menu is skipped by keyboard and Escape restores focus", async ({ page, isMobile }) => {
  test.skip(!isMobile, "The desktop navigation is always visible.");
  await page.goto("/create");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const toggle = page.getByRole("button", { name: "Open navigation", exact: true });
  await expect(navigation).toBeHidden();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: "Home", exact: true }).focus();
  await page.keyboard.press("Escape");
  await expect(navigation).toBeHidden();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
});

test("watching a later step preserves step numbers and identifies the current instruction", async ({ page }) => {
  await page.goto("/tutorial/example-espresso/your-everyday-espresso");
  const steps = page.locator(".tutorial-step");
  await steps.nth(1).click();
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(steps.first()).not.toHaveAttribute("aria-current", "step");
  await expect(steps.first().locator(".step-number")).toHaveText("01");
  await expect(steps.nth(1).locator(".step-number")).toHaveText("02");
});
