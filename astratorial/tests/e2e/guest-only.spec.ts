import { expect, test, type Page } from "@playwright/test";
import type { AppConfig, Tutorial } from "../../lib/contracts";
import { getExample } from "../../lib/examples";

const guest = { id: "guest-owner" };
const config = (user: AppConfig["user"]): AppConfig => ({
  configured: true,
  generationMode: "illustrated",
  services: { database: true, openai: true, worker: true },
  user,
});

async function expectGuestInterface(page: Page) {
  await expect(page.locator('a[href^="/login"], a[href^="/settings"]')).toHaveCount(0);
  await expect(page.getByRole("link", { name: /sign in|sign up|log in|log out|account|settings/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /sign in|sign up|log in|log out|account settings/i })).toHaveCount(0);
  await expect(page.locator('input[type="email"], input[type="password"]')).toHaveCount(0);
}

for (const existingGuest of [false, true]) {
  test(`core pages offer only guest navigation ${existingGuest ? "with" : "before"} a saved session`, async ({ page }) => {
    let guestRequests = 0;
    await page.route("**/api/config", route => route.fulfill({ json: config(existingGuest ? guest : null) }));
    await page.route("**/api/tutorials?*", route => route.fulfill({ json: { tutorials: [] } }));
    await page.route("**/api/auth/guest", route => { guestRequests++; return route.abort(); });

    for (const path of ["/", "/library", "/explore", "/create"]) {
      await page.goto(path);
      await expect(page.locator("main h1")).toBeVisible();
      await expectGuestInterface(page);
    }
    expect(guestRequests).toBe(0);
  });
}

test("old account and settings links return to the guest library", async ({ page }) => {
  await page.route("**/api/config", route => route.fulfill({ json: config(null) }));
  for (const path of ["/login", "/settings"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/library$/);
    await expect(page.getByRole("heading", { name: "Your everyday possibilities." })).toBeVisible();
    await expectGuestInterface(page);
  }
});

for (const existingGuest of [false, true]) {
  test(`adapting a shared tutorial ${existingGuest ? "reuses the browser's guest session" : "starts a guest session automatically"}`, async ({ page }) => {
    const example = getExample("example-espresso")!;
    const sharedId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const privateId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const shared: Tutorial = { ...example, id: sharedId, ownerId: "", isExample: false };
    const draft: Tutorial = { ...shared, id: privateId, ownerId: guest.id, visibility: "private", status: "draft", plan: null, scene: null };
    let activeGuest = existingGuest;
    const order: string[] = [];
    await page.route("**/api/config", route => route.fulfill({ json: config(activeGuest ? guest : null) }));
    await page.route("**/api/auth/guest", route => {
      expect(route.request().method()).toBe("POST");
      activeGuest = true;
      order.push("guest");
      return route.fulfill({ json: { user: guest } });
    });
    await page.route(`**/api/tutorials/${sharedId}`, route => route.fulfill({ json: { tutorial: shared } }));
    await page.route(`**/api/tutorials/${sharedId}/adapt`, route => {
      expect(route.request().method()).toBe("POST");
      expect(activeGuest).toBe(true);
      order.push("adapt");
      return route.fulfill({ json: { tutorial: draft } });
    });
    await page.route(`**/api/tutorials/${privateId}`, route => route.fulfill({ json: { tutorial: draft } }));
    await page.route("**/api/uploads?*", route => route.fulfill({ json: { uploads: [] } }));

    await Promise.all([
      page.waitForResponse(response => new URL(response.url()).pathname === "/api/config"),
      page.goto(`/tutorial/${sharedId}/${shared.slug}`),
    ]);
    await page.getByRole("button", { name: "Adapt to my space" }).click();
    await expect(page).toHaveURL(new RegExp(`/create\\?id=${privateId}$`));
    await expect(page.getByRole("heading", { name: "Start with a video." })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record a video", exact: true })).toBeEnabled();
    await expectGuestInterface(page);
    expect(order).toEqual(existingGuest ? ["adapt"] : ["guest", "adapt"]);
  });
}
