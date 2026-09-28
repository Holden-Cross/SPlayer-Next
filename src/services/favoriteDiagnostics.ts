import type { FavoriteDiagnostic, FavoriteTrace } from "@shared/types/apis";

/**
 * 创建可跨降级请求复用的操作编号
 * @param source - 操作入口或同步来源
 * @returns 本地诊断上下文
 */
export const favoriteTrace = (source: string): FavoriteTrace => ({
  operationId: crypto.randomUUID(),
  source,
});

/**
 * 诊断写入失败不影响用户操作
 * @param trace - 当前操作上下文
 * @param event - 诊断阶段
 * @param fields - 本地状态或 ID 快照
 */
export const favoriteDiagnostic = (
  trace: FavoriteTrace,
  event: FavoriteDiagnostic["event"],
  fields: Omit<FavoriteDiagnostic, keyof FavoriteTrace | "event"> = {},
): void => {
  try {
    window.api.apis.favoriteDiagnostic({ ...trace, event, ...fields });
  } catch {}
};
