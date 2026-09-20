import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { RoleDefinition } from "@clocktower/domain";
import { buildNightOrder } from "./nightOrder";
import { NightOrderPanel } from "./NightOrderPanel";

afterEach(cleanup);
const roles: RoleDefinition[] = [
  { id: "late", name: "晚醒角色", team: "townsfolk", ability: "能力", firstNight: 7500, otherNight: 20, firstNightReminder: "首夜提示", otherNightReminder: "后续提示" },
  { id: "traveler", name: "旅行者角色", team: "traveler", ability: "旅行者能力", firstNight: 1, otherNight: 1 },
  { id: "early", name: "早醒角色", team: "minion", ability: "能力", firstNight: 2300, otherNight: 5000 },
  { id: "other", name: "仅后续夜晚", team: "demon", ability: "能力", firstNight: 0, otherNight: 40 },
  { id: "first", name: "仅首夜", team: "townsfolk", ability: "能力", firstNight: 4000 },
  { id: "never", name: "从不唤醒", team: "townsfolk", ability: "能力" }
];
describe("night action order", () => {
  it("uses positive wake values only as sort keys and numbers each night independently", () => {
    expect(buildNightOrder(roles, "first", false).map(({ role, position }) => [role.id, position])).toEqual([["early", 1], ["first", 2], ["late", 3]]);
    expect(buildNightOrder(roles, "other", false).map(({ role, position }) => [role.id, position])).toEqual([["late", 1], ["other", 2], ["early", 3]]);
    expect(buildNightOrder([...roles, roles[0]], "first", true).map(({ role, position }) => [role.id, position])).toEqual([["traveler", 1], ["early", 2], ["first", 3], ["late", 4]]);
  });
  it("switches the displayed sequence and instructions, and honors traveler visibility", async () => {
    const { rerender } = render(<NightOrderPanel roles={roles} showTravelers={false} />);
    const first = screen.getByRole("list", { name: "首个夜晚行动顺序" });
    expect(within(first).getAllByRole("listitem").map(item => item.querySelector("strong")?.textContent)).toEqual(["早醒角色", "仅首夜", "晚醒角色"]);
    expect(screen.getByText("首夜提示")).toBeInTheDocument();
    expect(screen.queryByText("7500")).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "其他夜晚" }));
    expect(within(screen.getByRole("list", { name: "其他夜晚行动顺序" })).getAllByRole("listitem").map(item => item.querySelector("strong")?.textContent)).toEqual(["晚醒角色", "仅后续夜晚", "早醒角色"]);
    expect(screen.getByText("后续提示")).toBeInTheDocument();
    expect(screen.queryByText("首夜提示")).not.toBeInTheDocument();
    rerender(<NightOrderPanel roles={roles} showTravelers />);
    expect(screen.getByText("旅行者角色")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")[0]).toHaveTextContent("1旅行者角色");
  });
});
