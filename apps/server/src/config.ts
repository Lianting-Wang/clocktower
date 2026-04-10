import path from "node:path";
import { fileURLToPath } from "node:url";

import type { SourceMode } from "@clocktower/content";

export interface AppConfig {
  port: number;
  host: string;
  rootDir: string;
  sqlitePath: string;
  roomTtlHours: number;
  publicBaseUrl: string;
  contentMode: SourceMode;
  officialSyncEnabled: boolean;
  officialSyncOnBoot: boolean;
  officialSyncInterval: number;
  assetMirrorEnabled: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parseNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): AppConfig {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.."
  );
  const port = parseNumber(process.env.PORT, 3100);
  const host = process.env.HOST ?? "0.0.0.0";
  const publicBaseUrl =
    process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`;
  const contentMode = (process.env.CONTENT_MODE ??
    "mirror_official") as SourceMode;

  return {
    port,
    host,
    rootDir,
    sqlitePath:
      process.env.SQLITE_PATH ?? path.resolve(rootDir, "data/clocktower.sqlite"),
    roomTtlHours: parseNumber(process.env.ROOM_TTL_HOURS, 24),
    publicBaseUrl,
    contentMode,
    officialSyncEnabled: parseBoolean(process.env.OFFICIAL_SYNC_ENABLED, true),
    officialSyncOnBoot: parseBoolean(process.env.OFFICIAL_SYNC_ON_BOOT, true),
    officialSyncInterval: parseNumber(process.env.OFFICIAL_SYNC_INTERVAL, 60 * 60 * 1000),
    assetMirrorEnabled: parseBoolean(process.env.ASSET_MIRROR_ENABLED, true)
  };
}
