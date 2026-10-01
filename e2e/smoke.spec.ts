import { expect, test } from '@playwright/test';

const password = process.env.SEED_PASSWORD ?? 'dev-demo-password';

test('clinic admin signs in, plays a customer in the sandbox and gets an instant reply', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email').fill('admin@demo-clinic.test');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

  await page.goto('/sandbox');
  await page.getByLabel('Customer message').fill('Hi, I need teeth whitening');
  await page.getByRole('button', { name: 'Send' }).click();
  // The assistant answers through the simulated WhatsApp (3 s debounce + the rule-based model).
  await expect(page.getByText(/how soon|Could you tell me/i).first()).toBeVisible({ timeout: 20_000 });

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
});
