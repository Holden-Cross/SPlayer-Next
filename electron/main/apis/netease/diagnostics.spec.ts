// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), endpoint: vi.fn() }));
vi.mock("electron", () => ({ app: { getVersion: () => "diagnostic-test" } }));
vi.mock("@main/utils/logger", () => ({ neteaseLog: mocks }));
vi.mock("@main/database/sessions", () => ({
  getSessionCookies: () => ({ MUSIC_U: "secret-cookie" }),
  clearSessionCookies: vi.fn(),
  saveSessionCookies: vi.fn(),
}));
vi.mock("@main/store", () => ({ store: { get: () => false } }));
vi.mock("./core/device", () => ({
  getAnonymousToken: () => "",
  getDeviceId: () => "device",
  setAnonymousToken: vi.fn(),
  setDeviceId: vi.fn(),
}));
vi.mock("./core/xeapi", () => ({ resetXeapiKey: vi.fn() }));
vi.mock("./core/request", () => ({ createRequest: vi.fn() }));
vi.mock("./modules", () => ({
  modules: { likelist: mocks.endpoint, like_v1: mocks.endpoint, playlist_tracks: mocks.endpoint },
}));
import {
  favoriteChunks,
  favoriteFields,
  favoriteLog,
  favoriteRequestContext,
  rendererFavoriteLog,
} from "./diagnostics";
import { callNetease } from "./index";
import { cacheClear } from "./core/cache";

const records = () =>
  [...mocks.info.mock.calls, ...mocks.warn.mock.calls].map((call) => JSON.parse(call[1]));

beforeEach(() => {
  cacheClear();
  mocks.endpoint.mockReset();
});
describe("收藏诊断", () => {
  it("拒绝凭据和任意响应对象，账号仅保留稳定摘要", () => {
    const fields = favoriteFields({
      uid: 123,
      trackId: "456",
      like: false,
      cookie: "secret",
      token: "secret",
      body: { secret: true },
    });
    expect(fields).toEqual({ trackId: "456", like: false, account: expect.any(String) });
    expect(fields.account).not.toBe("123");
    expect(favoriteFields({ userId: 123 }).account).toBe(fields.account);
    rendererFavoriteLog({
      event: "snapshot",
      operationId: "op",
      source: "cache",
      ids: ["456", "secret"],
      ...{ cookie: "secret" },
    });
    expect(JSON.stringify(records())).not.toContain("secret");
  });
  it("完整记录超过 200 个 ID，保留空快照且不依赖日志对象展开", () => {
    const ids = Array.from({ length: 451 }, (_, i) => String(i + 1));
    expect(favoriteChunks(ids).map((chunk) => chunk.length)).toEqual([200, 200, 51]);
    favoriteLog("snapshot", {}, ids);
    const snapshots = records().filter((record) => record.event === "snapshot");
    expect(snapshots.flatMap((record) => record.ids)).toEqual(ids);
    expect(new Set(snapshots.map((record) => record.snapshotId)).size).toBe(1);
    expect(favoriteChunks([])).toEqual([[]]);
  });
  it("日志写入失败不会阻止业务", () => {
    mocks.info.mockImplementationOnce(() => {
      throw new Error("disk");
    });
    expect(() => favoriteLog("snapshot", {}, ["1"])).not.toThrow();
  });
  it("读取命中缓存时不再执行接口，诊断上下文不改变缓存键", async () => {
    mocks.endpoint.mockResolvedValue({ status: 200, body: { code: 200, ids: [1, 2] } });
    const params = { uid: 123 };
    await callNetease("likelist", params, { operationId: "first", source: "startup" });
    await callNetease("likelist", params, { operationId: "second", source: "refresh" });
    expect(mocks.endpoint).toHaveBeenCalledTimes(1);
    expect(mocks.endpoint.mock.calls[0][0]).toEqual({
      uid: 123,
      cookie: { MUSIC_U: "secret-cookie" },
    });
    expect(params).toEqual({ uid: 123 });
    expect(records()).toContainEqual(
      expect.objectContaining({ event: "cache-hit", operationId: "second" }),
    );
    expect(JSON.stringify(records())).not.toContain("secret-cookie");
  });
  it("并发请求上下文隔离，写请求每次执行且失败保留编号", async () => {
    mocks.endpoint.mockImplementation(async (query) => {
      await new Promise((resolve) => setTimeout(resolve, query.id === "1" ? 15 : 1));
      favoriteLog("network-test", { trackId: query.id });
      return { status: 200, body: { code: 200 } };
    });
    await Promise.all([
      callNetease("like_v1", { id: "1", like: true }, { operationId: "a", source: "button" }),
      callNetease("like_v1", { id: "2", like: false }, { operationId: "b", source: "tray" }),
    ]);
    expect(records()).toContainEqual(
      expect.objectContaining({ event: "network-test", operationId: "a", trackId: "1" }),
    );
    expect(records()).toContainEqual(
      expect.objectContaining({ event: "network-test", operationId: "b", trackId: "2" }),
    );
    await callNetease("like_v1", { id: "1", like: true });
    expect(mocks.endpoint).toHaveBeenCalledTimes(3);
    const failure = Object.assign(new Error("secret-response"), {
      response: { status: 401, body: { code: 401, cookie: "secret" } },
    });
    mocks.endpoint.mockRejectedValueOnce(failure);
    await expect(
      callNetease("like_v1", { id: "3", like: false }, { operationId: "failed", source: "button" }),
    ).rejects.toBe(failure);
    expect(records()).toContainEqual(
      expect.objectContaining({ event: "failure", operationId: "failed", status: 401 }),
    );
    expect(JSON.stringify(records())).not.toContain("secret-response");
    expect(favoriteRequestContext.getStore()).toBeUndefined();
  });
});
