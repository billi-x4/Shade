import { expect, test } from "@playwright/test";

/**
 * Orchard-only testnet Unified Address: the Orchard receiver of zcash-test-vectors
 * unified_address.json (account 2, diversifier 0; backend/test/fixtures/zcash/vectors) re-encoded
 * with the `utest` HRP. It decodes as a valid UA with an Orchard receiver, but nobody holds its
 * keys — never send funds to it.
 */
const TESTNET_UA =
  "utest18z20cdj59zmjdl23hyxzrgn0hr7tlexmmkwav5nwzpgd27yk4y0dc7mwwn3c0cp960swz78h7fqsvxg72jvv4mehvvattdaemqljkrk4";

test("merchant loop: sign up, set an address, invoice, pay page, grant view", async ({
  page,
  browser,
}) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = "correct horse battery staple";

  await test.step("sign up and sign in", async () => {
    await page.goto("/signup");
    await page.getByLabel("Shop name").fill("E2E Coffee");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();

    // The test backend runs without email verification, so sign-up hands over to sign-in.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Account created. Sign in to open your desk.")).toBeVisible();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/desk\/invoices$/);
    await expect(page.getByRole("heading", { level: 1, name: "Invoices" })).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Desk" });
    for (const name of ["Invoices", "Jars", "Grants", "Webhooks"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
  });

  await test.step("add a testnet receive address", async () => {
    await page.getByRole("link", { name: "Add a testnet receive address" }).click();
    await expect(page).toHaveURL(/\/desk\/settings\/address$/);
    await page.getByLabel("Unified Address").fill(TESTNET_UA);
    await page.getByRole("button", { name: "Save address" }).click();
    await expect(page.getByText(TESTNET_UA).first()).toBeVisible();
  });

  let payUrl = "";
  await test.step("create an invoice", async () => {
    await page
      .getByRole("navigation", { name: "Desk" })
      .getByRole("link", { name: "Invoices" })
      .click();
    await page.getByLabel("Amount (ZEC)").fill("0.01");
    await page.getByLabel("Memo").fill("order_1042");
    await page.getByLabel("Label (for grants)").fill("payroll");
    await page.getByRole("button", { name: "Create invoice" }).click();
    await expect(
      page.getByText("Invoice for 0.01 ZEC created. Send the payer this link."),
    ).toBeVisible();
    payUrl =
      (await page.getByRole("link", { name: "Open pay page" }).first().getAttribute("href")) ?? "";
    expect(payUrl).toMatch(/\/pay\/inv_/);
  });

  await test.step("open the pay page as the payer", async () => {
    const payer = await browser.newContext();
    const payPage = await payer.newPage();
    await payPage.goto(payUrl);
    await expect(
      payPage.getByRole("heading", { level: 1, name: "Pay privately with Zcash." }),
    ).toBeVisible();
    await expect(payPage.getByRole("link", { name: "Open in wallet" })).toHaveAttribute(
      "href",
      /^zcash:utest1[0-9a-z]+\?amount=0\.01&memo=[A-Za-z0-9_-]+$/,
    );
    await expect(payPage.getByRole("img", { name: /QR code to pay 0\.01 ZEC/ })).toBeVisible();
    await expect(payPage.getByText("Waiting for your payment.")).toBeVisible();
    await expect(payPage.getByText("order_1042", { exact: true })).toBeVisible();
    // Pay by hand offers the exact on-chain memo: the merchant memo plus its shade reference.
    await payPage.getByText("Wallet did not open? Pay by hand").click();
    await expect(payPage.getByText(/^order_1042 \(shade:[0-9A-Z]{8}\)$/)).toBeVisible();
    await expect(payPage.getByRole("button", { name: "Copy memo" })).toBeVisible();
    await payer.close();
  });

  await test.step("share a 10-minute grant and open it as the auditor", async () => {
    await page
      .getByRole("navigation", { name: "Desk" })
      .getByRole("link", { name: "Grants" })
      .click();
    await page.getByLabel("Share for").selectOption({ label: "10 minutes" });
    await expect(
      page.getByText("Share view for 10 minutes. Scope: all invoices. You can revoke anytime."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create grant" }).click();

    const dialog = page.getByRole("dialog", { name: "Share this view link" });
    await expect(dialog).toBeVisible();
    const viewUrl = ((await dialog.locator("code").first().textContent()) ?? "").trim();
    expect(viewUrl).toMatch(/\/view#gv_[A-Za-z0-9_-]+$/);
    await dialog.getByRole("button", { name: "I saved it" }).click();
    await expect(dialog).toBeHidden();

    const auditor = await browser.newContext();
    const view = await auditor.newPage();
    await view.goto(viewUrl);
    await expect(view.getByRole("heading", { level: 1, name: "Receipts" })).toBeVisible();
    await expect(view.getByText("All invoices and jar charges")).toBeVisible();
    await expect(view.getByText("No receipts yet.")).toBeVisible();
    // The token leaves the address bar once read.
    expect(new URL(view.url()).hash).toBe("");
    await auditor.close();
  });
});
