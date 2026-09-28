import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import { neteaseLog } from "@main/utils/logger";
import type { FavoriteDiagnostic, FavoriteTrace } from "@shared/types/apis";

const runId = randomUUID();
let started = false;
export const favoriteRequestContext = new AsyncLocalStorage<
  FavoriteTrace & { requestId: string; name: string }
>();
export const tracedFavoriteApis = new Set([
  "like",
  "like_v1",
  "playlist_tracks",
  "playlist_delete",
  "likelist",
  "user_playlist",
  "playlist_detail",
]);

/**
 * 仅输出诊断所需的标量，拒绝对象和过长字段
 * @param value - 待筛选的诊断字段
 * @returns 可记录的字段及账号摘要
 */
export const favoriteFields = (value: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const key of [
    "wireId",
    "operationId",
    "source",
    "requestId",
    "name",
    "id",
    "pid",
    "trackId",
    "playlistId",
    "like",
    "liked",
    "wasLiked",
    "op",
    "status",
    "code",
    "httpStatus",
    "attempt",
    "elapsedMs",
    "count",
    "part",
    "parts",
    "snapshotId",
    "cache",
    "uri",
    "crypto",
    "errorName",
  ]) {
    const field = value[key];
    if (
      typeof field === "boolean" ||
      (typeof field === "number" && Number.isFinite(field)) ||
      (typeof field === "string" && field.length <= 256)
    )
      out[key] = field;
  }
  if (
    typeof value.userId === "number" ||
    typeof value.uid === "number" ||
    typeof value.uid === "string"
  ) {
    out.account = createHash("sha256")
      .update(String(value.userId ?? value.uid))
      .digest("hex")
      .slice(0, 16);
  }
  return out;
};

/**
 * 按固定上限分块，空列表也留下快照证据
 * @param ids - 接口或本地集合中的 ID
 * @returns 每块最多 200 个合法数字 ID
 */
export const favoriteChunks = (ids: unknown[]): string[][] => {
  const safe = ids
    .filter((id) => typeof id === "string" || typeof id === "number")
    .map(String)
    .filter((id) => /^\d+$/.test(id) && id.length <= 32);
  const chunks: string[][] = [];
  for (let i = 0; i < safe.length; i += 200) chunks.push(safe.slice(i, i + 200));
  return chunks.length ? chunks : [[]];
};

/**
 * 统一关联运行、操作和请求，日志失败不影响收藏
 * @param event - 诊断阶段
 * @param fields - 需要白名单筛选的上下文字段
 * @param ids - 可选的 ID 快照
 * @param failed - 是否使用警告级别
 */
export const favoriteLog = (
  event: string,
  fields: Record<string, unknown> = {},
  ids?: unknown[],
  failed = false,
): void => {
  try {
    if (!started) {
      started = true;
      neteaseLog.info(
        "[favorite-diagnostic]",
        JSON.stringify({
          event: "run",
          runId,
          version: app.getVersion(),
          platform: process.platform,
          utc: new Date().toISOString(),
        }),
      );
    }
    const base = {
      runId,
      utc: new Date().toISOString(),
      event,
      ...favoriteFields({ ...favoriteRequestContext.getStore(), ...fields }),
    };
    const write = (data: unknown): void => {
      if (failed) neteaseLog.warn("[favorite-diagnostic]", JSON.stringify(data));
      else neteaseLog.info("[favorite-diagnostic]", JSON.stringify(data));
    };
    if (ids) {
      const chunks = favoriteChunks(ids);
      const snapshotId = randomUUID();
      chunks.forEach((chunk, i) =>
        write({
          ...base,
          snapshotId,
          count: ids.length,
          part: i + 1,
          parts: chunks.length,
          ids: chunk,
        }),
      );
    } else write(base);
  } catch {}
};

/**
 * 接收限定的渲染端事件，不输出任意对象
 * @param event - 渲染端诊断事件
 */
export const rendererFavoriteLog = (event: FavoriteDiagnostic): void => {
  if (
    !event ||
    ![
      "operation",
      "success",
      "rollback",
      "fallback",
      "sync-start",
      "sync-end",
      "snapshot",
    ].includes(event.event)
  )
    return;
  favoriteLog(
    "renderer-" + event.event,
    { ...event },
    Array.isArray(event.ids) ? event.ids : undefined,
    event.event === "rollback",
  );
};
