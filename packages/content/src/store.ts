import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  contentCatalogSchema,
  type ContentCatalog
} from "@clocktower/protocol";

export interface ContentPaths {
  rootDir: string;
  contentDir: string;
  assetsDir: string;
  baseCatalogPath: string;
  runtimeCatalogPath: string;
}

export interface LoadCatalogResult {
  catalog: ContentCatalog;
  loadedFrom: "runtime" | "base" | "empty";
  issues: string[];
}

export const EMPTY_CATALOG: ContentCatalog = {
  sourceMode: "local",
  syncedAt: undefined,
  assetsBaseUrl: "/content/assets",
  countdownAudioUrl: undefined,
  issues: [],
  roles: [],
  fabled: [],
  editions: []
};

export function resolveContentPaths(rootDir: string): ContentPaths {
  const contentDir = path.resolve(rootDir, "data/content");
  const assetsDir = path.resolve(rootDir, "data/assets");

  return {
    rootDir,
    contentDir,
    assetsDir,
    baseCatalogPath: path.join(contentDir, "catalog.json"),
    runtimeCatalogPath: path.join(contentDir, "catalog.runtime.json")
  };
}

export async function ensureContentPaths(paths: ContentPaths): Promise<void> {
  await mkdir(paths.contentDir, { recursive: true });
  await mkdir(paths.assetsDir, { recursive: true });
}

async function readCatalogFile(filePath: string): Promise<ContentCatalog | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return contentCatalogSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function loadCatalog(paths: ContentPaths): Promise<LoadCatalogResult> {
  const issues: string[] = [];
  const runtime = await readCatalogFile(paths.runtimeCatalogPath);
  if (runtime) {
    return {
      catalog: runtime,
      loadedFrom: "runtime",
      issues
    };
  }

  if (await exists(paths.runtimeCatalogPath)) {
    issues.push("Runtime catalog exists but could not be parsed. Falling back.");
  }

  const base = await readCatalogFile(paths.baseCatalogPath);
  if (base) {
    return {
      catalog: base,
      loadedFrom: "base",
      issues
    };
  }

  if (await exists(paths.baseCatalogPath)) {
    issues.push("Base catalog exists but could not be parsed. Starting empty.");
  }

  return {
    catalog: { ...EMPTY_CATALOG },
    loadedFrom: "empty",
    issues
  };
}

export async function saveCatalog(
  paths: ContentPaths,
  catalog: ContentCatalog
): Promise<void> {
  await ensureContentPaths(paths);
  const payload = JSON.stringify(contentCatalogSchema.parse(catalog), null, 2);
  await writeFile(paths.runtimeCatalogPath, payload, "utf8");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
