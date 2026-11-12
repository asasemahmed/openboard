import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'app', environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'] },
});
