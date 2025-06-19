// vitest.setup.ts
import '@testing-library/jest-dom';
import { vi } from 'vitest';

// グローバルなfetchのモック
global.fetch = vi.fn();

// localStorageのモック
Object.defineProperty(window, 'localStorage', {
  value: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  },
  writable: true,
});