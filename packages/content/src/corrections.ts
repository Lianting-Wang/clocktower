import type { ContentCatalog } from "@clocktower/protocol";

const ROLE_CORRECTIONS: Record<string, Partial<ContentCatalog["roles"][number]>> = {
  "pit-hag": { otherNight: 2900 }
};

export function applyKnownContentCorrections(catalog: ContentCatalog): ContentCatalog {
  return {
    ...catalog,
    roles: catalog.roles.map(role => {
      const correction = ROLE_CORRECTIONS[role.id];
      return correction ? { ...role, ...correction } : role;
    })
  };
}
