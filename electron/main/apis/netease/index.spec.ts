// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  login: vi.fn(),
  request: vi.fn(),
  warn: vi.fn(),
  userInfo: vi.fn(),
  hostname: vi.fn(),
}));

vi.mock("node:os", () => ({ userInfo: mocks.userInfo, hostname: mocks.hostname }));
vi.mock("@main/database/sessions", () => ({
  getSessionCookies: () => ({ deviceId: "stable-device", MUSIC_U: "old-token" }),
  saveSessionCookies: mocks.save,
  clearSessionCookies: vi.fn(),
}));
vi.mock("@main/store", () => ({ store: { get: () => false } }));
vi.mock("@main/utils/logger", () => ({ neteaseLog: { warn: mocks.warn } }));
vi.mock("./core/request", () => ({ createRequest: mocks.request }));
vi.mock("./core/xeapi", () => ({ resetXeapiKey: vi.fn() }));
vi.mock("./modules", () => ({ modules: { login_qr_check: mocks.login } }));

import { callNetease, setNeteaseCookies } from "./index";

describe("扫码登录设备名称上报", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key) => (key === "platform" ? "win32" : Reflect.get(target, key)),
      }),
    );
    mocks.userInfo.mockReset().mockReturnValue({ username: "admin" });
    mocks.hostname.mockReset().mockReturnValue("DESKTOP-H255");
    mocks.request.mockReset().mockResolvedValue({ status: 200, body: { code: 200 }, cookie: [] });
    mocks.login.mockReset().mockResolvedValue({
      status: 200,
      body: { code: 803 },
      cookie: ["MUSIC_U=new-token; Path=/", "__csrf=new-csrf; Path=/"],
    });
    setNeteaseCookies({ deviceId: "stable-device", MUSIC_U: "old-token" });
    mocks.save.mockClear();
  });

  it("保存登录凭据后使用同一设备身份上报，且不等待上报完成", async () => {
    let finish!: (value: unknown) => void;
    mocks.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const result = await callNetease("login_qr_check", { key: "qr-key" });
    expect(result.body.code).toBe(803);
    expect(mocks.save.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.request.mock.invocationCallOrder[0],
    );
    expect(mocks.request).toHaveBeenCalledWith(
      "/api/deviceinfo/center/upload",
      { deviceName: "admin 的 DESKTOP-H255" },
      expect.objectContaining({
        crypto: "eapi",
        cookie: { deviceId: "stable-device", MUSIC_U: "new-token", __csrf: "new-csrf" },
      }),
    );
    const snapshot = mocks.request.mock.calls[0][2].cookie;
    setNeteaseCookies({ MUSIC_U: "another-account", deviceId: "another-device" });
    expect(snapshot.MUSIC_U).toBe("new-token");
    finish({ status: 200, body: { code: 200 } });
  });

  it("保留中文和名称内部空格", async () => {
    mocks.userInfo.mockReturnValue({ username: "小明 admin" });
    await callNetease("login_qr_check");
    expect(mocks.request.mock.calls[0][1]).toEqual({ deviceName: "小明 admin 的 DESKTOP-H255" });
  });

  it.each([800, 801, 802, 500])("状态 %s 不上报", async (code) => {
    mocks.login.mockResolvedValue({ status: 200, body: { code }, cookie: [] });
    await callNetease("login_qr_check");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("非 Windows 不上报", async () => {
    vi.stubGlobal(
      "process",
      new Proxy(process, {
        get: (target, key) => (key === "platform" ? "linux" : Reflect.get(target, key)),
      }),
    );
    await callNetease("login_qr_check");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(["system", "network", "business"])(
    "%s 失败不影响登录且不泄露错误详情",
    async (failure) => {
      if (failure === "system")
        mocks.userInfo.mockImplementation(() => {
          throw new Error("secret");
        });
      if (failure === "network") mocks.request.mockRejectedValue(new Error("secret"));
      if (failure === "business")
        mocks.request.mockResolvedValue({ status: 200, body: { code: 400 } });
      expect((await callNetease("login_qr_check")).body.code).toBe(803);
      expect(mocks.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("secret");
      expect(mocks.request.mock.calls.length).toBeLessThanOrEqual(1);
    },
  );
});
