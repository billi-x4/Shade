import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

/**
 * Pay page layout at phone and desktop widths (PRD §10: must work on a phone). The API is mocked
 * in the browser, so this needs only the Vite dev server: no account, no database writes.
 */
const ADDRESS =
  "utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4";

function publicInvoice(amount: string) {
  return {
    id: "inv_layout",
    status: "open",
    progress: "awaiting",
    network: "testnet",
    amount_zec: amount,
    memo: "Order 1042",
    address: ADDRESS,
    zip321: `zcash:${ADDRESS}?amount=${amount}&memo=T3JkZXIgMTA0Mg`,
    merchant_name: "Northline Coffee",
    expires_at: new Date(Date.now() + 42 * 60_000).toISOString(),
    paid_at: null,
    confirmations: null,
    required_confirmations: 1,
  };
}

async function openPayPage(page: Page, amount: string) {
  // Match on the path prefix: a "**/api/**" glob would also catch Vite's /src/api/*.ts modules.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/public/invoices/inv_layout") {
        return route.fulfill({ json: publicInvoice(amount) });
      }
      return route.fulfill({ status: 404, json: { error: "NOT_FOUND", message: "Not mocked." } });
    },
  );
  await page.goto("/pay/inv_layout");
  await expect(page.getByRole("link", { name: "Open in wallet" })).toBeVisible();
}

/** Horizontal overflow, the unit's right edge against the column, and whether the digits split. */
function measure(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    const unit = [...document.querySelectorAll("main p > span")].find(
      (span) => span.textContent === "ZEC",
    );
    const digits = unit?.parentElement?.firstElementChild;
    if (!main || !unit || !digits) throw new Error("amount not rendered");
    const column =
      main.getBoundingClientRect().right - parseFloat(getComputedStyle(main).paddingRight);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      unitRight: unit.getBoundingClientRect().right,
      column,
      digitLines: digits.getClientRects().length,
    };
  });
}

const VIEWPORTS = [
  { name: "small phone", width: 320, height: 640 },
  { name: "phone", width: 390, height: 844 },
  { name: "desktop", width: 1280, height: 800 },
];
const AMOUNTS = ["0.01", "0.71428571", "12.12345678", "1234.5678901", "20999999.99999999"];

for (const viewport of VIEWPORTS) {
  test.describe(`pay amount at ${viewport.width}px`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const amount of AMOUNTS) {
      test(`${amount} ZEC stays inside the column`, async ({ page }) => {
        await openPayPage(page, amount);
        const box = await measure(page);
        expect(box.scrollWidth).toBeLessThanOrEqual(box.innerWidth);
        expect(box.unitRight).toBeLessThanOrEqual(box.column + 0.5);
        // The amount is never split across lines; only the unit may wrap below it.
        expect(box.digitLines).toBe(1);
      });
    }
  });
}
