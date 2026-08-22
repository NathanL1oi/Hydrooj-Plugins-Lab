# Hydrooj-Plugins-Lab

HydroOJ 自定义插件合集：从线上 `/root/.hydro/addon.json` 登记的 21 个本地插件只读导出，按功能重新分类；同时归档本地开发仓库中尚未启用的插件。导出时已剔除 `node_modules`、`.git`、`dist`、`build`、缓存与日志等产物。

## 目录结构

| 目录 | 说明 |
| --- | --- |
| `01-homepage-frontend` | 首页与前端外观（模板覆盖、浮窗、背景图、编辑器主题等） |
| `02-account-interaction` | 账号交互（徽章、金币/商城） |
| `03-domain-user-management` | 域内用户管理（用户管理、注册引导、年级分组） |
| `04-course-learning` | 课程学习（课程系统、客观题增强） |
| `05-problem-solution` | 题目与题解 |
| `06-contest-rating` | 比赛与 Rating（批量提交、VP、实时榜单等） |
| `07-content-system` | 内容系统（赛后总结、讨论搜索） |
| `90-local-disabled` | 本地开发仓库独有待启用插件的归档（默认不启用） |

## 清单与文档

- `installed-addons.clean.json`：21 个线上插件的导出清单（源路径、版本、文件数）。
- `90-local-disabled/disabled-plugins.manifest.json`：68 个归档插件清单。
- `MERGE_PLAN.md`：线上版与本地版的合并方案与冲突清单。
- `MIGRATION_ASSESSMENT.md`：迁移成本与风险评估。

## 备注

- `01~07` 分类目录中的插件是线上正在运行的版本，作为迁移基线。
- 同一功能存在多个实现时以线上版为准，归档版本只用于抽取差异功能。
- `04-course-learning/HydroOJ-Course` 的完整开发历史见其独立仓库，此处为当前快照（含成绩表排名、访问控制、计分与文件上传的修复）。
