import type { RoleDefinition } from "@clocktower/domain";

export type NightPeriod = "first" | "other";

export function buildNightOrder(roles: RoleDefinition[], period: NightPeriod, showTravelers: boolean) {
  const key = period === "first" ? "firstNight" : "otherNight";
  return [...new Map(roles.map(role => [role.id, role])).values()]
    .filter(role => (showTravelers || role.team !== "traveler") && Number.isFinite(role[key]) && role[key]! > 0)
    .sort((left, right) => left[key]! - right[key]!)
    .map((role, index) => ({ role, position: index + 1 }));
}
