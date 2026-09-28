import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  diagnostic: vi.fn(),
  getItem: vi.fn(),
  setItem: vi.fn(),
}));
vi.mock("localforage", () => ({
  default: { createInstance: () => ({ getItem: mocks.getItem, setItem: mocks.setItem }) },
}));
import { useUserStore } from "./user";

beforeEach(() => {
  setActivePinia(createPinia());
  mocks.call.mockReset();
  mocks.getItem.mockReset();
  mocks.setItem.mockResolvedValue(undefined);
  Object.defineProperty(window, "api", {
    configurable: true,
    value: { apis: { call: mocks.call, favoriteDiagnostic: mocks.diagnostic } },
  });
});
describe("收藏操作诊断", () => {
  it("红心接口失败后歌单降级沿用同一操作编号", async () => {
    const store = useUserStore();
    store.playlists = [{ id: "99" } as never];
    mocks.call.mockImplementation(async (_platform, name) => ({
      ok: true,
      status: 200,
      body:
        name === "like_v1" || name === "like"
          ? { code: 401, msg: "401" }
          : { code: 200, count: 1, playlist: [] },
    }));
    expect(await store.toggleLike("123", "full-player")).toBe(true);
    const writes = mocks.call.mock.calls.filter((call) =>
      ["like_v1", "like", "playlist_tracks"].includes(call[1]),
    );
    expect(writes.map((call) => call[1])).toEqual(["like_v1", "like", "playlist_tracks"]);
    expect(new Set(writes.map((call) => call[3].operationId)).size).toBe(1);
    expect(writes[2][2]).toEqual({ op: "add", pid: "99", tracks: "123" });
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fallback", source: "like-to-playlist" }),
    );
  });

  it("新版失败降级旧版复用操作编号，随后取消使用新编号", async () => {
    mocks.call
      .mockResolvedValueOnce({ ok: false, status: 500, error: "failed" })
      .mockResolvedValue({ ok: true, status: 200, body: { code: 200 } });
    const store = useUserStore();
    expect(await store.toggleLike("123", "player-bar")).toBe(true);
    const [first, fallback] = mocks.call.mock.calls;
    expect(first.slice(0, 3)).toEqual(["netease", "like_v1", { id: "123", like: true }]);
    expect(fallback.slice(0, 3)).toEqual(["netease", "like", { id: "123", like: true }]);
    expect(first[3]).toEqual(fallback[3]);
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fallback", operationId: first[3].operationId }),
    );
    expect(await store.toggleLike("123", "tray")).toBe(true);
    const cancel = mocks.call.mock.calls[2];
    expect(cancel[2]).toEqual({ id: "123", like: false });
    expect(cancel[3].operationId).not.toBe(first[3].operationId);
    expect(cancel[3].source).toBe("tray");
  });
  it("写入失败保持原有回滚并记录目标与恢复状态", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.call.mockResolvedValue({ ok: false, status: 500, error: "failed" });
    const store = useUserStore();
    expect(await store.toggleLike("123")).toBe(false);
    expect(store.isLiked("123")).toBe(false);
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "operation", liked: true, wasLiked: false }),
    );
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "rollback", liked: false }),
    );
  });
  it("启动缓存和远端集合变化留下证据且不调用任何写接口", async () => {
    mocks.getItem.mockImplementation(async (key) =>
      key === "liked-song-ids" ? { userId: 7, ids: ["10"] } : null,
    );
    mocks.call.mockImplementation(async (_platform, name) => ({
      ok: true,
      status: 200,
      body:
        name === "likelist" ? { ids: [20] } : { code: 200, playlist: [], data: [], hasMore: false },
    }));
    const store = useUserStore();
    await store.loadContent(7);
    expect([...store.likedSongIds]).toEqual(["20"]);

    expect(
      mocks.call.mock.calls.every(
        (call) => !["like", "like_v1", "playlist_tracks", "playlist_delete"].includes(call[1]),
      ),
    ).toBe(true);
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "liked-ids-cache", ids: ["10"] }),
    );
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "likelist-apply:added", ids: ["20"] }),
    );
    expect(mocks.diagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ source: "likelist-apply:removed", ids: ["10"] }),
    );
  });
});
