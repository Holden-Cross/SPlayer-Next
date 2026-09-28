// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), fetch: vi.fn() }));
vi.mock("electron", () => ({ app: { getVersion: () => "test" } }));
vi.mock("@main/utils/logger", () => ({ neteaseLog: mocks }));
vi.mock("@main/utils/proxy", () => ({ fetchWithProxy: mocks.fetch }));
vi.mock("./device", () => ({ getAnonymousToken: () => "", getDeviceId: () => "device" }));
vi.mock("./xeapi", () => ({}));
vi.mock("./checktoken", () => ({ getAntiCheatTokenV3: vi.fn() }));
import { createRequest } from "./request";
import { favoriteRequestContext } from "../diagnostics";

const records = () =>
  [...mocks.info.mock.calls, ...mocks.warn.mock.calls].map((call) => JSON.parse(call[1]));
beforeEach(() => {
  mocks.fetch.mockReset();
});
describe("实际请求诊断", () => {
  it("记录真正发送次数与 HTTP/业务码，不输出 Cookie 或响应文本", async () => {
    mocks.fetch
      .mockRejectedValueOnce(new TypeError("secret-network-message"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 401, msg: "secret-response" }), { status: 200 }),
      );
    await expect(
      favoriteRequestContext.run(
        { operationId: "op", source: "test", requestId: "req", name: "like" },
        () =>
          createRequest(
            "/api/radio/like",
            { trackId: "123", like: false },
            { crypto: "api", cookie: { MUSIC_U: "secret-cookie" } },
          ),
      ),
    ).rejects.toThrow();
    const events = records();
    expect(
      events.filter((event) => event.event === "network-send").map((event) => event.attempt),
    ).toEqual([1, 2]);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "network-response", httpStatus: 200, requestId: "req" }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: "wire-result", status: 401, code: 401 }),
    );
    expect(new Set(events.filter((event) => event.wireId).map((event) => event.wireId)).size).toBe(
      1,
    );
    expect(JSON.stringify(events)).not.toContain("secret");
  });
  it("响应读取异常单独留证且保持原有返回行为", async () => {
    mocks.fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      text: async () => {
        throw new Error("read failed");
      },
    });
    const response = await favoriteRequestContext.run(
      { operationId: "op", source: "test", requestId: "parse", name: "like" },
      () => createRequest("/api/radio/like", { trackId: "123", like: true }, { crypto: "api" }),
    );
    expect(response.body).toEqual({ code: 200, msg: "parse failed" });
    expect(records()).toContainEqual(
      expect.objectContaining({ event: "response-parse-failed", requestId: "parse" }),
    );
  });
  it("普通请求不产生收藏诊断日志", async () => {
    mocks.fetch.mockResolvedValue(new Response('{"code":200}'));
    await createRequest("/api/test", {}, { crypto: "api" });
    expect(mocks.info).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
