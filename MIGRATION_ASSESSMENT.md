# 线上插件整理与替换评估

## 当前状态

本仓库从线上 `addon.json` 中的 21 个本地自定义插件只读导出，并按功能重新分类。导出时未复制 `node_modules`、`.git`、`dist`、`build`、缓存和日志等运行/编译产物。

线上没有被修改，也没有重启 Hydro。

## 替换成本评估

如果目标是“保持线上功能不变，只把插件目录整理成现在这种结构”，成本中等：

- 代码整理和清单校验：已完成初步导出。
- 路径替换与 `addon.json` 顺序整理：约 30 分钟。
- 逐插件 smoke test：约 2-4 小时。
- 生产切换：约 15-30 分钟，建议保留旧 `addon.json` 一键回滚。

如果目标是“完全换成现在本地这套插件，并合并线上差异”，成本偏高：

- 需要逐个比较线上导出版与本地 `hydroplugin` 仓库版本。
- 风险主要在模板覆盖、模型 monkey patch、同路由插件和比赛/课程相关插件。
- 预计 1-2 天比较稳妥。

## 主要风险点

- `01-homepage-frontend/frontend-33oj` 是强模板覆盖插件，和任何导航、页脚、用户卡片、题目列表模板插件都容易冲突。
- `02-account-interaction/coin-33oj`、`badge-33oj` 带模型和模板，切换时要确认用户详情页、排行榜、商城/徽章入口正常。
- `04-course-learning/hydrooj-course` 和 `rich-objective-kit` 都是较重插件，课程页、客观题渲染、题目引用需要重点测。
- `06-contest-rating/contest-bulk-submit`、`contest-pdf`、`contest-flexible-start`、`hydro-hide-objective-score` 都会影响比赛流程，不能和旧路径重复加载。
- `07-content-system/contest-summary` 线上版本可能包含你之前改过的每日限制、白名单和 URL 设置，必须和本地版本比对后再替换。

## 建议迁移方式

1. 先把本仓库推到新 Git 仓库，作为线上现状快照。
2. 在新分支中和当前 `hydroplugin` 仓库逐插件比对。
3. 在服务器新增一个干净目录，例如 `/root/hydro-clean-plugins`，不要覆盖旧目录。
4. 生成新的 `addon.json`，保持原加载顺序，只替换路径。
5. 先在低峰期重启 Hydro 验证。
6. 若异常，立即恢复旧 `addon.json` 并重启。

## 难度插件结论

项目中没有找到已经独立出来的“洛谷难度插件”。现有洛谷式难度逻辑分散在：

- `01-homepage-frontend/frontend-bpjudge`：前端显示和 `ProblemModel` 同步逻辑。
- `05-problem-solution/problem-zip-replace`：题包导入时识别难度。

如果要独立难度插件，建议从 `frontend-bpjudge` 抽出难度相关代码，但不要带它的导航、页脚、用户页覆盖。
