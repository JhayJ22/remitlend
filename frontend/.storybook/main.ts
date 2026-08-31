import type { StorybookConfig } from "@storybook/nextjs";

/**
 * Monorepo-aware Storybook for the `frontend/` Next.js app.
 *
 * - Uses the `@storybook/nextjs` framework so App Router, `next/font`,
 *   `next/image` and the Tailwind v4 pipeline resolve exactly as in the app.
 * - Stories are co-located with components under `src/`.
 * - `@storybook/addon-a11y` surfaces axe-core findings per story; the same
 *   engine backs the CI accessibility checks (see `.github/workflows/a11y.yml`).
 */
const config: StorybookConfig = {
  stories: ["../src/**/*.mdx", "../src/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-essentials",
    "@storybook/addon-interactions",
    "@storybook/addon-a11y",
  ],
  framework: {
    name: "@storybook/nextjs",
    options: {},
  },
  staticDirs: ["../public"],
  docs: {
    autodocs: "tag",
  },
  typescript: {
    reactDocgen: "react-docgen-typescript",
  },
};

export default config;
