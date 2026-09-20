import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlayerState, RoleDefinition } from "@clocktower/domain";
import { ReminderPanel } from "./ReminderPanel";

afterEach(cleanup);
const demon: RoleDefinition = { id: "no_dashii", name: "诺-达鲺", team: "demon", ability: "", image: "/no_dashii.png", reminders: ["死亡", "中毒"], remindersGlobal: ["中毒", "全局标记"] };
const seamstress: RoleDefinition = { id: "seamstress", name: "女裁缝", team: "townsfolk", ability: "", image: "/seamstress.png", reminders: ["普通标记", "失去能力"] };
const player: PlayerState = { seatId: "s2", name: "玩家2", roleId: "chef", isDead: false, isVoteless: false, reminders: [] };
describe("reminders supplied by roles in play", () => {
  it("adds a demon's markers to other players while retaining their source and icon", async () => {
    const send = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ReminderPanel player={player} sources={[demon, demon]} onSend={send} />);
    expect(screen.getAllByRole("button", { name: "添加诺-达鲺标记：中毒" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "添加诺-达鲺标记：全局标记" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "添加诺-达鲺标记：死亡" }));
    expect(send).toHaveBeenLastCalledWith({ type: "upsert_reminder", seatId: "s2", reminder: { id: "s2:role:no_dashii:死亡", name: "死亡", roleId: "no_dashii", iconUrl: "/no_dashii.png" } });
    for (const seatId of ["s1", "s3"]) {
      rerender(<ReminderPanel player={{ ...player, seatId }} sources={[demon]} onSend={send} />);
      await user.click(screen.getByRole("button", { name: "添加诺-达鲺标记：中毒" }));
      expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ seatId, reminder: expect.objectContaining({ roleId: "no_dashii", name: "中毒" }) }));
    }
  });
  it("prevents duplicate source markers and removes only the chosen marker", async () => {
    const send = vi.fn();
    render(<ReminderPanel player={{ ...player, reminders: [{ id: "existing", name: "中毒", roleId: "no_dashii", iconUrl: "/no_dashii.png" }] }} sources={[demon]} onSend={send} />);
    expect(screen.getByRole("button", { name: "添加诺-达鲺标记：中毒" })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("button", { name: "移除诺-达鲺标记：中毒" }));
    expect(send).toHaveBeenCalledWith({ type: "remove_reminder", seatId: "s2", reminderId: "existing" });
  });
  it("shows loss of ability only on its own role and puts that role and marker first", () => {
    const { rerender } = render(<ReminderPanel player={player} sources={[demon, seamstress]} onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "添加女裁缝标记：失去能力" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加女裁缝标记：普通标记" })).toBeInTheDocument();

    rerender(<ReminderPanel player={{ ...player, roleId: "seamstress" }} sources={[demon, seamstress]} onSend={vi.fn()} />);
    const groups = screen.getAllByRole("region", { name: /提供的标记/ });
    expect(groups[0]).toHaveAccessibleName("女裁缝提供的标记");
    const buttons = groups[0].querySelectorAll("button");
    expect(buttons[0]).toHaveAccessibleName("添加女裁缝标记：失去能力");
    expect(buttons[1]).toHaveAccessibleName("添加女裁缝标记：普通标记");
  });
});
