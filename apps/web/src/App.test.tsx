import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sourceMode: "local",
          assetsBaseUrl: "/content/assets",
          issues: [],
          roles: [],
          fabled: [],
          editions: []
        })
      })
    );
  });

  it("renders the landing screen", async () => {
    render(<App />);
    expect(await screen.findByText("创建房间")).toBeInTheDocument();
    expect(screen.getByText("本地自托管的血染钟楼魔典")).toBeInTheDocument();
  });
});
