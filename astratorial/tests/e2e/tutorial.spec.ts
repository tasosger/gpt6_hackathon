import { expect, test } from "@playwright/test";

const example = "/tutorial/example-espresso/your-everyday-espresso";

test("home filters examples and opens a real interactive player", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /A little guidance/ })).toBeVisible();
  await page.getByRole("button", { name: "Coffee & rituals", exact: true }).click();
  await expect(page.locator(".tutorial-card")).toHaveCount(1);
  await page.goto(example);
  await expect(page.getByRole("heading", {name:"Your everyday espresso"})).toBeVisible();
  await expect(page.locator("canvas")).toBeVisible();
  await page.getByRole("button", {name:"First person",exact:true}).click();
  await expect(page.getByRole("button", {name:"First person",exact:true})).toHaveClass(/active/);
  await page.getByRole("button", {name:"Free view",exact:true}).click();
  await expect(page.getByText("Drag to orbit · Pinch to zoom")).toBeVisible();
  await page.getByRole("button", {name:"Play tutorial",exact:true}).click();
  await expect(page.getByRole("slider", {name:"Tutorial timeline"})).not.toHaveValue("0");
  await page.getByRole("button", {name:"Pause tutorial",exact:true}).click();
  await page.getByRole("button", {name:"Pop in a coffee pod"}).click();
  await expect(page.locator(".scene-caption")).toContainText("STEP 2 OF 6");
  await page.getByRole("button", {name:"Replay current step"}).click();
  await expect(page.getByRole("combobox", {name:"Playback speed"})).toHaveValue("1");
  await page.getByRole("combobox", {name:"Playback speed"}).selectOption("0.5");
  await expect(page.getByRole("combobox", {name:"Playback speed"})).toHaveValue("0.5");
  await page.getByRole("button", {name:"Talk to tutor",exact:true}).click();
  await expect(page.getByText(/Live voice connects to your own saved tutorial/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("practice handles denied camera access and offers a return route", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {value: () => Promise.reject(new DOMException("Denied", "NotAllowedError"))});
  });
  await page.goto(`${example}/practice`);
  await page.getByRole("button", {name:"Open my camera"}).click();
  await expect(page.getByText(/Camera permission was denied/)).toBeVisible();
  await expect(page.getByRole("button", {name:"Open my camera"})).toBeEnabled();
  await page.getByRole("link", {name:"Back to the 3D tutorial"}).click();
  await expect(page).toHaveURL(new RegExp(`${example}$`));
});

test("core routes fit the screen and do not expose connected features without setup", async ({ page }) => {
  for (const route of ["/", "/library", "/explore", "/create", "/login", "/settings", example, `${example}/practice`]) {
    await page.goto(route);
    await expect(page.locator("main")).toBeVisible();
    const dimensions = await page.evaluate(() => ({width:document.documentElement.clientWidth, content:document.documentElement.scrollWidth}));
    expect(dimensions.content, `${route} should not overflow horizontally`).toBeLessThanOrEqual(dimensions.width + 1);
  }
  const config = await page.request.get("/api/config");
  expect(config.ok()).toBeTruthy();
  const data = await config.json();
  expect(data).not.toHaveProperty("OPENAI_API_KEY");
  if (!data.configured) {
    const result = await page.request.post("/api/tutorials", {data:{goal:"Make coffee"}});
    expect([401,503]).toContain(result.status());
  }
});
