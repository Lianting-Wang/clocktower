import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { contentCatalogSchema, type ContentCatalog } from "@clocktower/protocol";
import type { RoleTeam } from "@clocktower/domain";

import { type ContentPaths } from "./store.js";
import { applyKnownContentCorrections } from "./corrections.js";

export interface SyncOfficialOptions {
  paths: ContentPaths;
  assetsBaseUrl?: string;
  assetMirrorEnabled?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface SyncOfficialResult {
  catalog: ContentCatalog;
  syncedAt: string;
  issues: string[];
}

const OFFICIAL_ROLE_URL = "https://clocktower.gstonegames.com/ct/grimoireRoleJson/";
const OFFICIAL_EDITIONS_URL = "https://clocktower.gstonegames.com/ct/grimoire_edition_list/";
const KNOWN_AUDIO_ASSETS = [
  "https://oss.gstonegames.com/data_file/clocktower/web/sounds/countdown.mp3"
];

const OFFICIAL_EDITION_LABELS: Record<string, string> = {
  tb: "暗流涌动",
  bmr: "黯月初升",
  snv: "梦殒春宵",
  hdcs: "华灯初上",
  exp: "实验性角色",
  syyl: "试验角色集"
};

export async function syncOfficialCatalog(
  options: SyncOfficialOptions
): Promise<SyncOfficialResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const issues: string[] = [];

  const rolesResponse = await postJson(fetchImpl, OFFICIAL_ROLE_URL, undefined, timeoutMs);
  const editionTabs = await Promise.all([
    postJson(
      fetchImpl,
      OFFICIAL_EDITIONS_URL,
      { tab: 1, name: "", order: 1, page: 1, limit: 100 },
      timeoutMs
    ),
    postJson(
      fetchImpl,
      OFFICIAL_EDITIONS_URL,
      { tab: 2, name: "", order: 1, page: 1, limit: 100 },
      timeoutMs
    ),
    postJson(
      fetchImpl,
      OFFICIAL_EDITIONS_URL,
      { tab: 3, name: "", order: 1, page: 1, limit: 100 },
      timeoutMs
    )
  ]);

  const rolesData = (rolesResponse.data ?? {}) as {
    role?: Array<Record<string, unknown>>;
    fabled?: Array<Record<string, unknown>>;
  };
  const rawRoles = rolesData.role ?? [];
  const rawFabled = rolesData.fabled ?? [];
  const officialEditions = buildOfficialEditions(rawRoles);
  const remoteEditions = editionTabs.flatMap((payload, index) =>
    (((payload.data ?? {}) as { items?: Array<Record<string, unknown>> }).items ?? []).map((item) =>
      normalizeRemoteEdition(item, index + 1)
    )
  );

  const normalizedRoles = rawRoles.map((role) => normalizeRole(role));
  const normalizedFabled = rawFabled.map((item) => ({
    ...normalizeRole(item),
    team: "fabled" as const
  }));

  let catalog: ContentCatalog = applyKnownContentCorrections({
    sourceMode: "mirror_official",
    syncedAt: new Date().toISOString(),
    assetsBaseUrl: options.assetsBaseUrl ?? "/content/assets",
    countdownAudioUrl: KNOWN_AUDIO_ASSETS[0],
    issues,
    roles: normalizedRoles,
    fabled: normalizedFabled,
    editions: [...officialEditions, ...remoteEditions]
  });

  if (options.assetMirrorEnabled !== false) {
    catalog = await mirrorCatalogAssets(catalog, options.paths, fetchImpl, timeoutMs, issues);
  }

  return {
    catalog: contentCatalogSchema.parse(catalog),
    syncedAt: catalog.syncedAt ?? new Date().toISOString(),
    issues
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`Upstream ${url} returned ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const status = Number(payload.status ?? 0);
  if (status !== 200) {
    throw new Error(`Upstream ${url} reported status ${status}`);
  }

  return payload;
}

function normalizeRole(input: Record<string, unknown>) {
  return {
    id: String(input.id ?? ""),
    name: String(input.name ?? input.id ?? ""),
    team: normalizeTeam(input.team),
    ability: String(input.ability ?? ""),
    image: asOptionalString(input.image),
    imageAlt: asOptionalString(input.imageAlt),
    firstNight: asOptionalNumber(input.firstNight),
    otherNight: asOptionalNumber(input.otherNight),
    firstNightReminder: asOptionalString(input.firstNightReminder),
    otherNightReminder: asOptionalString(input.otherNightReminder),
    setup: asOptionalNumber(input.setup) ?? asOptionalBoolean(input.setup) ?? undefined,
    reminders: Array.isArray(input.reminders)
      ? input.reminders.map((item) => String(item))
      : undefined,
    remindersGlobal: Array.isArray(input.remindersGlobal)
      ? input.remindersGlobal.map((item) => String(item))
      : undefined,
    edition: input.edition ? String(input.edition) : undefined,
    isOfficial: Boolean(input.isOfficial),
    flavor: asOptionalString(input.flavor)
  };
}

function normalizeTeam(value: unknown): RoleTeam {
  const fallback: RoleTeam = "townsfolk";
  const text = String(value ?? fallback) as RoleTeam;
  return [
    "townsfolk",
    "outsider",
    "minion",
    "demon",
    "traveler",
    "fabled"
  ].includes(text)
    ? text
    : fallback;
}

function buildOfficialEditions(
  roles: Array<Record<string, unknown>>
): ContentCatalog["editions"] {
  const grouped = new Map<string, string[]>();
  for (const role of roles) {
    const editionId = role.edition ? String(role.edition) : undefined;
    const roleId = role.id ? String(role.id) : undefined;
    if (!editionId || !roleId) {
      continue;
    }
    const next = grouped.get(editionId) ?? [];
    next.push(roleId);
    grouped.set(editionId, next);
  }

  return [...grouped.entries()].map(([id, roleIds]) => ({
    id,
    name: OFFICIAL_EDITION_LABELS[id] ?? id,
    roles: roleIds,
    isOfficial: true
  }));
}

function normalizeRemoteEdition(
  item: Record<string, unknown>,
  tab: number
): ContentCatalog["editions"][number] {
  const numericId = String(item.id ?? item.game_id ?? `remote_${tab}`);
  return {
    id: `remote:${numericId}`,
    name: String(item.name ?? numericId),
    desc: asOptionalString(item.desc),
    story: asOptionalString(item.story),
    image: asOptionalString(item.image),
    roles: [],
    isOfficial: Boolean(item.isOfficial),
    source: `tab:${tab}`,
    json: asOptionalString(item.json)
  };
}

async function mirrorCatalogAssets(
  catalog: ContentCatalog,
  paths: ContentPaths,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  issues: string[]
): Promise<ContentCatalog> {
  const assetMap = new Map<string, string>();
  const urls = extractAssetUrls(catalog).concat(KNOWN_AUDIO_ASSETS);
  const uniqueUrls = [...new Set(urls)];
  const results = await Promise.allSettled(
    uniqueUrls.map(async (url) => ({
      url,
      localUrl: await mirrorAsset(url, paths, fetchImpl, timeoutMs, catalog.assetsBaseUrl)
    }))
  );

  results.forEach((result, index) => {
    const url = uniqueUrls[index] ?? "";
    if (result.status === "fulfilled") {
      assetMap.set(result.value.url, result.value.localUrl);
      return;
    }
    issues.push(
      `Failed to mirror asset ${url}: ${
        result.reason instanceof Error ? result.reason.message : "unknown error"
      }`
    );
  });

  return rewriteUrls(catalog, assetMap) as ContentCatalog;
}

async function mirrorAsset(
  url: string,
  paths: ContentPaths,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  assetsBaseUrl: string
): Promise<string> {
  const remote = new URL(url);
  const localDir = path.join(paths.assetsDir, remote.hostname, path.dirname(remote.pathname));
  const localFile = path.join(paths.assetsDir, remote.hostname, remote.pathname);
  await mkdir(localDir, { recursive: true });

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs)
  });

  if (!response.ok) {
    throw new Error(`asset response ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(localFile, buffer);

  return `${assetsBaseUrl}/${remote.hostname}${remote.pathname}`;
}

function extractAssetUrls(input: unknown): string[] {
  if (typeof input === "string") {
    return /^https?:\/\//i.test(input) ? [input] : [];
  }

  if (Array.isArray(input)) {
    return input.flatMap((item) => extractAssetUrls(item));
  }

  if (input && typeof input === "object") {
    return Object.values(input).flatMap((value) => extractAssetUrls(value));
  }

  return [];
}

function rewriteUrls(value: unknown, assetMap: Map<string, string>): unknown {
  if (typeof value === "string") {
    return assetMap.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewriteUrls(item, assetMap));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rewriteUrls(entry, assetMap)])
    );
  }

  return value;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
