import {
  contentCatalogSchema,
  type ContentCatalog
} from "@clocktower/protocol";

import {
  EMPTY_CATALOG,
  ensureContentPaths,
  loadCatalog,
  resolveContentPaths,
  saveCatalog,
  type ContentPaths
} from "./store.js";
import { syncOfficialCatalog, type SyncOfficialOptions } from "./official.js";
import { applyKnownContentCorrections } from "./corrections.js";

export type SourceMode = ContentCatalog["sourceMode"];

export interface SyncCatalogOptions extends Omit<SyncOfficialOptions, "paths"> {
  rootDir: string;
  sourceMode?: SourceMode;
}

export interface SyncCatalogResult {
  catalog: ContentCatalog;
  syncedAt?: string;
  issues: string[];
  usedFallback: boolean;
  loadedFrom: "runtime" | "base" | "empty";
}

export async function readLocalCatalog(rootDir: string): Promise<SyncCatalogResult> {
  const paths = resolveContentPaths(rootDir);
  await ensureContentPaths(paths);
  const local = await loadCatalog(paths);

  return {
    catalog: applyKnownContentCorrections(contentCatalogSchema.parse(local.catalog)),
    issues: local.issues,
    usedFallback: false,
    loadedFrom: local.loadedFrom
  };
}

export async function syncCatalog(options: SyncCatalogOptions): Promise<SyncCatalogResult> {
  const sourceMode = options.sourceMode ?? "mirror_official";
  const paths = resolveContentPaths(options.rootDir);
  await ensureContentPaths(paths);
  const local = await loadCatalog(paths);

  if (sourceMode === "local" || sourceMode === "import_only") {
    return {
      catalog: applyKnownContentCorrections({
        ...local.catalog,
        sourceMode
      }),
      issues: local.issues,
      usedFallback: false,
      loadedFrom: local.loadedFrom
    };
  }

  if (sourceMode === "remote_proxy") {
    return {
      catalog: applyKnownContentCorrections({
        ...local.catalog,
        sourceMode
      }),
      issues: [
        ...local.issues,
        "remote_proxy mode is configured but no upstream proxy adapter is installed; using local snapshot."
      ],
      usedFallback: true,
      loadedFrom: local.loadedFrom
    };
  }

  try {
    const result = await syncOfficialCatalog({
      ...options,
      paths,
      assetsBaseUrl: options.assetsBaseUrl ?? "/content/assets"
    });
    await saveCatalog(paths, result.catalog);

    return {
      catalog: result.catalog,
      syncedAt: result.syncedAt,
      issues: [...local.issues, ...result.issues],
      usedFallback: false,
      loadedFrom: local.loadedFrom
    };
  } catch (error) {
    const fallbackIssues = [...local.issues];
    fallbackIssues.push(
      `Official sync failed, using ${local.loadedFrom} catalog: ${
        error instanceof Error ? error.message : "unknown error"
      }`
    );

    return {
      catalog: applyKnownContentCorrections(local.catalog ?? { ...EMPTY_CATALOG }),
      syncedAt: local.catalog.syncedAt,
      issues: fallbackIssues,
      usedFallback: true,
      loadedFrom: local.loadedFrom
    };
  }
}

export {
  EMPTY_CATALOG,
  ensureContentPaths,
  loadCatalog,
  resolveContentPaths,
  saveCatalog,
  syncOfficialCatalog,
  type ContentPaths
};
