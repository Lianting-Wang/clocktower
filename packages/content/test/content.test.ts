import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  readLocalCatalog,
  resolveContentPaths,
  saveCatalog,
  syncCatalog
} from "../src/index.js";

describe("content storage", () => {
  it("saves and reloads a local catalog", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clocktower-content-"));
    const paths = resolveContentPaths(root);

    await saveCatalog(paths, {
      sourceMode: "local",
      syncedAt: "2026-01-01T00:00:00.000Z",
      assetsBaseUrl: "/content/assets",
      issues: [],
      roles: [],
      fabled: [],
      editions: []
    });

    const result = await readLocalCatalog(root);
    expect(result.catalog.sourceMode).toBe("local");
    expect(result.loadedFrom).toBe("runtime");
  });

  it("falls back to the local snapshot when upstream sync fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clocktower-content-"));
    const paths = resolveContentPaths(root);

    await saveCatalog(paths, {
      sourceMode: "local",
      syncedAt: "2026-01-01T00:00:00.000Z",
      assetsBaseUrl: "/content/assets",
      issues: [],
      roles: [],
      fabled: [],
      editions: []
    });

    const result = await syncCatalog({
      rootDir: root,
      fetchImpl: async () => {
        throw new Error("boom");
      }
    });

    expect(result.usedFallback).toBe(true);
    expect(result.catalog.roles).toHaveLength(0);
  });

  it("writes a runtime JSON file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clocktower-content-"));
    const paths = resolveContentPaths(root);

    await saveCatalog(paths, {
      sourceMode: "local",
      syncedAt: "2026-01-01T00:00:00.000Z",
      assetsBaseUrl: "/content/assets",
      issues: [],
      roles: [],
      fabled: [],
      editions: []
    });

    const raw = await readFile(paths.runtimeCatalogPath, "utf8");
    expect(raw).toContain("\"sourceMode\": \"local\"");
  });
});
