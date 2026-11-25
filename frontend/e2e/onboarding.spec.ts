import { test, expect } from '@playwright/test';

test.describe('New borrower onboarding flow', () => {
  test('redirects users without an NFT from the dashboard to onboarding', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/onboarding/);
    await expect(page.getByRole('heading', { name: /onboarding/i })).toBeVisible();
  });

  test('redirects from /loans and /lend to onboarding', async ({ page }) => {
    await page.goto('/loans');
    await expect(page).toHaveURL(/\/onboarding/);

    await page.goto('/lend');
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test('shows the four onboarding steps with progress', async ({ page }) => {
    await page.goto('/onboarding');

    const stepper = page.getByTestId('wizard-stepper');
    await expect(stepper).toBeVisible();

    await expect(page.getByText('Connect Wallet')).toBeVisible();
    await expect(page.getByText('Mint Identity NFT')).toBeVisible();
    await expect(page.getByText('Import Remittance History')).toBeVisible();
    await expect(page.getByText('Request First Loan')).toBeVisible();
  });

  test('completes the full onboarding flow and unlocks the dashboard', async ({ page }) => {
    await page.goto('/onboarding');

    // Step 1: Connect Wallet
    await page.getByRole('button', { name: /connect wallet/i }).click();
    await expect(page.getByTestId('step-connect-wallet')).toHaveAttribute('data-status', 'complete');

    // Step 2: Mint Identity NFT (calls remittance_nft contract)
    await page.getByRole('button', { name: /mint identity nft/i }).click();
    await expect(page.getByTestId('step-mint-nft')).toHaveAttribute('data-status', 'complete');

    // Step 3: Import Remittance History
    await expect(page.getByText(/upload a remittance csv/i)).toBeVisible();
    await page.getByRole('button', { name: /import remittance history/i }).click();
    await expect(page.getByTestId('step-import-history')).toHaveAttribute('data-status', 'complete');

    // Step 4: Request First Loan
    await page.getByRole('button', { name: /request first loan/i }).click();
    await expect(page.getByTestId('step-request-loan')).toHaveAttribute('data-status', 'complete');

    // Completion unlocks the dashboard and awards onboarding XP
    await expect(page.getByTestId('onboarding-complete')).toBeVisible();
    await page.getByRole('button', { name: /go to dashboard/i }).click();
    await expect(page).toHaveURL(/\/(dashboard)?$/);
  });
});
