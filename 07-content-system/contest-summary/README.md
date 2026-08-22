# 比赛赛后总结插件

`hydrooj-contest-summary` 提供比赛赛后总结中心，适合在比赛详情页右侧加入“赛后总结”入口，让有权限查看该比赛的用户提交和阅读总结。

## 功能范围

- 比赛详情页右侧注入“赛后总结”入口。
- 全局总结中心为 `/contest-summary`。
- 从某场比赛进入时会先走 `/contest/:tid/summary`，随后跳转到 `/contest-summary?tid=:tid`，默认只显示该场比赛。
- 用户可以在列表页切换到全部可见比赛或其它可见比赛。
- 写总结入口为 `/contest-summary/write`，带 `?tid=:tid` 时默认选中该比赛；不带 `tid` 时需要用户自己选择一场可见比赛。
- 总结详情页为 `/contest-summary/detail/:sid`。
- 比赛管理员可以在 `/contest-summary/settings?tid=:tid` 配置写作要求、截止时间、最低字数、是否允许修改和 AI 评测参考资料。

## 权限模型

- 查看范围跟随比赛可见性：用户能看某场比赛，就能看该场比赛下未隐藏的总结。
- 不要求用户实际参加过比赛。
- Hydro `homework` 规则的作业不属于本插件目标，不会出现在比赛筛选和比赛详情入口中。
- 比赛 owner、maintainer、`PERM_EDIT_CONTEST` 或 `PERM_EDIT_DOMAIN` 用户可以管理该场总结、查看隐藏总结、设为优秀总结、填写老师评语。
- 普通用户只能修改或删除自己的总结，且受该场配置中的截止时间和 `allowEdit` 限制。

## AI 评测

插件会调用 evaluation-server：

- `PUT /api/tasks/{problem_id}`
- `POST /api/evaluations`
- `GET /api/evaluations/{evaluation_id}`

创建任务时传入：

```json
{
  "evaluation_type": 1
}
```

复用通用总结评测服务配置，不再提供比赛总结专用服务配置：

- `SummaryEvaluation.serverUrl`
- `SummaryEvaluation.apiKey`
- `SummaryEvaluation.timeoutMs`
- `SUMMARY_EVALUATION_SERVER_URL`
- `SUMMARY_EVALUATION_API_KEY`
- `SUMMARY_EVALUATION_TIMEOUT_MS`
- `EVALUATION_SERVER_URL`
- `EVALUATION_SERVER_API_KEY`
- `EVALUATION_SERVER_TIMEOUT_MS`

若未配置评测服务，用户仍可正常提交总结，只是不创建 AI 评测。

## 数据集合

- `domain.contest.summaryConfig`：按 `domainId + tid` 保存单场总结配置。
- `domain.contest.summarySubmit`：按 `domainId + tid + uid` 保存用户总结，保证同一用户同一比赛只有一篇总结。
- `system.contest.summaryRequestLimit`：按 `_id = day + uid` 记录每日提交次数，使用 MongoDB 默认 `_id` 索引，不需要额外数据库索引权限。

## 提交次数限制

- 系统设置 `ContestSummary.dailySubmitLimit` 控制每个用户每天最多提交次数，默认 3，填 0 表示不限。
- 系统设置 `ContestSummary.pageSize` 控制比赛总结列表每页数量，默认 20。
- 系统设置 `ContestSummary.limitWhitelist` 是全站白名单，填写 UID，支持换行、逗号或空格分隔；名单内用户不受每日提交次数限制。
- 超过限制时，本次请求会被忽略，不保存内容，也不会发起 AI 评测，并在写总结页顶部显示提示。
- 过期计数记录可通过脚本 `cleanupContestSummaryRequestLimit` 清理；清理按 `_id` 日期范围删除，也走默认 `_id` 索引。

## 路由

| 路由 | 作用 |
| --- | --- |
| `/contest-summary` | 总结中心，可按比赛、关键词、优秀总结筛选 |
| `/contest/:tid/summary` | 比赛详情页入口跳转路由 |
| `/contest-summary/write` | 写/修改总结 |
| `/contest-summary/detail/:sid` | 总结详情 |
| `/contest-summary/settings?tid=:tid` | 单场比赛总结配置 |
