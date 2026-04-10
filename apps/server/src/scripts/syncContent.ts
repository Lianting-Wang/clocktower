import { syncCatalog } from "@clocktower/content";

import { loadConfig } from "../config.js";

const config = loadConfig();
const result = await syncCatalog({
  rootDir: config.rootDir,
  sourceMode: config.contentMode,
  assetMirrorEnabled: config.assetMirrorEnabled
});

console.log(
  JSON.stringify(
    {
      syncedAt: result.syncedAt,
      usedFallback: result.usedFallback,
      issues: result.issues
    },
    null,
    2
  )
);
