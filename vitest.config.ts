import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/gui/renderer/**', 'src/**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(__dirname, 'src/core'),
      '@sandbox': path.resolve(__dirname, 'src/sandbox'),
      '@environments': path.resolve(__dirname, 'src/environments'),
      '@intelligence': path.resolve(__dirname, 'src/intelligence'),
      '@export': path.resolve(__dirname, 'src/export'),
      '@storage': path.resolve(__dirname, 'src/storage'),
      '@plugins': path.resolve(__dirname, 'src/plugins'),
      '@tools': path.resolve(__dirname, 'src/tools'),
      '@policy': path.resolve(__dirname, 'src/policy'),
    },
  },
});
