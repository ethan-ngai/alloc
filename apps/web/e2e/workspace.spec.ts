import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openView(page: Page, label: "Memory" | "Forecast" | "Activity") {
  const menu = page.getByRole("button", { name: "Open navigation" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: label, exact: true }).click();
}

test("all three synthetic company ledgers load from the mock contract", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByText("Scope view · not additive")).toBeVisible();

  await page.getByLabel("Company").selectOption("juniper");
  await expect(page.getByText("Juniper Table", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".scope-overlay > summary").getByText("Kitchen operations", { exact: true })).toBeVisible();

  await page.getByLabel("Company").selectOption("forge");
  await expect(page.getByText("Forge & Loom", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".scope-overlay > summary").getByText("Line operations", { exact: true })).toBeVisible();
});

test("pending review, memory, forecast, and activity remain operable", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Cumulative amendment limit exceeded")).toBeVisible();
  await openView(page, "Memory");
  await expect(page.getByRole("heading", { name: "Verified facts" })).toBeVisible();
  await page.getByLabel("Search company memory").fill("No matching fact");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText(/No verified facts match/)).toBeVisible();
  await openView(page, "Forecast");
  await expect(page.getByRole("img", { name: /Projected exposure rises/ })).toBeVisible();
  await openView(page, "Activity");
  await expect(page.getByRole("heading", { name: "Activity stream" })).toBeVisible();
  await page.getByRole("button", { name: "Details" }).first().click();
  await expect(page.getByText("Raw contract event")).toBeVisible();
  await page.keyboard.press("Control+K");
  await expect(page.getByLabel("Search company memory")).toBeFocused();
});

test("dependency errors explain recovery and do not display cached balances", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Demo state").selectOption("unavailable");
  await expect(page.getByRole("heading", { name: "The mock service is unavailable." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(page.getByText("$500.00 USD")).toHaveCount(0);
});

test("overview has no serious or critical accessibility violations", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations.filter((violation) => ["serious", "critical"].includes(violation.impact ?? ""))).toEqual([]);
});
