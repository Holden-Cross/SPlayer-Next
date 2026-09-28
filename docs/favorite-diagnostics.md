# 收藏同步诊断

分支：`diagnostics/netease-favorites`。基于当前版本，保留已有收藏、缓存和重试行为；没有额外的远端校验请求。新增日志默认开启，前缀为 `[favorite-diagnostic]`，不需要设置开关。

## 复现与收集

1. A、B 两端安装同一份诊断构建，确认登录同一个网易云账号。
2. 记录歌曲 ID 和每一步的本地时间（包括时区），注明客户端 A / B；记录 B 是完全退出后启动，还是从托盘恢复。
3. A 收藏一次，在官方 App 主动刷新后确认收藏；记录确认时间。
4. 启动 B，仅查看喜欢列表；再次刷新官方 App，记录歌曲是否消失。
5. 复现后立即使用设置中的打开日志目录功能，分别收集 A、B 当日日志及轮转文件。目录为 `{userData}/app-data/logs/`，开发环境在 `dev/`。日志按 UTC 日期命名，跨日时收集相邻日期。
6. 附上两个客户端的版本、上述时间线、歌曲 ID，以及是否曾点击红心、托盘或任务栏收藏按钮。

保持现有 2 MB 文件轮转限制；复现后尽快收集，避免后续大量操作覆盖早期证据。完整应用日志可能含其他功能的记录；本次新增诊断不记录 Cookie、Token、请求头或完整响应。

## 读取日志

每行诊断内容为 JSON。`runId` 标识本次主进程运行，`operationId` 串起一次操作及降级，`requestId` 标识一次 API 调用，`wireId` 标识一次请求构造（网络重试共享它）。账号仅记录用户 ID 的稳定摘要。两台机器的操作编号不会相同，通过歌曲 ID、账号摘要和 UTC 时间线对照。

- `renderer-operation`：用户操作，包含入口、目标状态和操作前状态；`renderer-success` / `renderer-rollback` 表示本地处理结果，不代表再次查询确认了云端状态。
- `call` → `cache-hit` / `wire-prepare` → `network-send` → `network-response` → `wire-result` → `result` / `failure`：区分调用、缓存、实际发送、HTTP 状态与业务码。
- `network-error` 表示某次发送抛错；后续 `attempt` 增加表示重试。发送抛错不能证明服务端未处理该请求。
- `renderer-fallback` 表示新版红心接口降级旧版，或红心接口降级歌单增删。歌单接口内部重试可通过同一请求下不同 `wireId` 和 ID 快照识别。
- `remote-likelist`、`remote-playlist` 与 `renderer-snapshot` 分别记录 API 返回和本地应用数据；API 返回可能来自缓存，须结合该 `requestId` 的 `cache-hit` 判断。
- `snapshotId`、`part`、`parts` 用于拼接每块最多 200 个歌曲 ID 的列表。`source` 后缀 `:before`、`:incoming`、`:added`、`:removed` 表示应用前、输入及集合差异。

重点查找目标歌曲对应的 `like=false`、`op=del`，以及喜欢歌单的 `playlist_delete`。只有完整时间段内的日志才能用于判断是否发出了写请求；不能仅凭缺少某一行认定没有发送。
