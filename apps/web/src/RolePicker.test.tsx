import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRoomState, type RoleDefinition } from "@clocktower/domain";
import { RolePicker } from "./RolePicker";

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});
afterEach(cleanup);
function fixture(count = 7) {
  const roles: RoleDefinition[] = [
    { id: "beggar", name: "乞丐", team: "traveler", ability: "旅行者能力", image: "/beggar.png" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: `town${i}`, name: `镇民${i}`, team: "townsfolk" as const, ability: "镇民能力", image: `/town${i}.png` })),
    { id: "butler", name: "管家", team: "outsider", ability: "", image: "/butler.png" },
    { id: "poisoner", name: "投毒者", team: "minion", ability: "", image: "/poisoner.png" },
    { id: "imp", name: "小恶魔", team: "demon", ability: "", image: "/imp.png" }
  ];
  const room = createRoomState({ roomId: "TEST", hostSecret: "secret" });
  room.edition = { id: "tb", name: "测试剧本", roles: roles.map(role => role.id) };
  room.players = Array.from({ length: count }, (_, i) => ({ seatId: `s${i}`, name: `玩家${i}`, isDead: false, isVoteless: false, reminders: [] }));
  const onSend = vi.fn();
  render(<RolePicker open room={room} catalog={{ roles, editions: [room.edition], fabled: [], sourceMode: "local", issues: [], assetsBaseUrl: "/" }} onClose={vi.fn()} onSend={onSend} serverError={null} />);
  return { user: userEvent.setup(), onSend };
}

describe("role selection workflow", () => {
  it("shows role icons and defaults Travelers off, appending them when enabled", async () => {
    const { user } = fixture();
    expect(screen.queryByRole("button", { name: /乞丐/ })).not.toBeInTheDocument();
    expect(document.querySelector('.role-option img')).toHaveAttribute("src", "/town0.png");
    await user.click(screen.getByRole("checkbox", { name: "显示旅行者" }));
    expect(screen.getByRole("button", { name: /乞丐/ })).toBeInTheDocument();
    expect([...document.querySelectorAll('.picker-team')].at(-1)).toHaveClass("traveler");
  });
  it("keeps random selection and manual edits private until explicit distribution", async () => {
    const { user, onSend } = fixture();
    await user.click(screen.getByRole("button", { name: "↻ 随机选择" }));
    expect(document.querySelectorAll('.role-option.is-selected')).toHaveLength(7);
    expect(onSend).not.toHaveBeenCalled();
    const selectedGood = document.querySelector('.picker-team.townsfolk .is-selected') as HTMLElement;
    await user.click(selectedGood);
    expect(document.querySelectorAll('.role-option.is-selected')).toHaveLength(6);
    expect(screen.getByRole("button", { name: "分发角色 · 6 人" })).toBeDisabled();
    await user.click(selectedGood);
    await user.click(screen.getByRole("button", { name: "随机选皮" }));
    expect(onSend).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "分发角色 · 7 人" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    const message = onSend.mock.calls[0][0];
    expect(message.type).toBe("distribute_roles");
    expect(message.roleIds).toHaveLength(7);
    expect(message.bluffRoleIds).toHaveLength(3);
    expect(message.bluffRoleIds.every((id: string) => !message.roleIds.includes(id))).toBe(true);
  });
  it("uses the six-player setup and permits distribution without bluffs", async () => {
    const { user, onSend } = fixture(6);
    await user.click(screen.getByRole("button", { name: "↻ 随机选择" }));
    const button = screen.getByRole("button", { name: "分发角色 · 6 人" });
    expect(button).toBeEnabled();
    await user.click(button);
    const bag = onSend.mock.calls[0][0].roleIds;
    expect(bag.filter((id: string) => id.startsWith("town"))).toHaveLength(3);
    expect(bag).toEqual(expect.arrayContaining(["butler", "poisoner", "imp"]));
  });
});
