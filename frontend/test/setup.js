/*
 * MoonlightWeb — TNR suite. Copyright (C) 2026 Bruno Martin.
 * GPLv3 — see repository LICENSE.
 */
import { vi } from 'vitest';

// basePath derives the mount prefix from import.meta.url, which under Vitest is
// the dev server's /@fs/<checkout>/frontend path, so every API URL would carry
// it. Tests run as if served at the root, i.e. not embedded.
vi.mock('../js/util/basePath.js', () => ({
    BASE: '',
    url: (path) => path,
    isEmbedded: () => false,
}));
