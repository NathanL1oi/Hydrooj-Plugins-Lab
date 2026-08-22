# Hydro 插件合并评估

生成时间：2026-07-12

目标：以 `hydrooj-plugins` 作为后续迁移和部署的主仓库，保留线上当前可运行插件；把 `hydroplugin` 中独有的插件收进同一仓库维护，但默认不启用，避免迁移时一次性打开过多功能。

## 结论

- 线上仓库 `hydrooj-plugins` 目前有 21 个插件，是生产环境实际跑过的版本，应作为迁移基线。
- 当前开发仓库 `hydroplugin` 有约 75 个 `package.json`，其中有一部分是正式插件，一部分是插件目录里嵌套的旧副本或依赖残留。
- 共同功能不要直接按包名覆盖。建议以 `hydrooj-plugins` 为准，再把 `hydroplugin` 中确实更新的功能补丁合进去。
- 当前独有插件应该收进新仓库，但登记为 `productionEnabled: false`。上线时只由清单生成 `addon.json`。

## 建议仓库状态

```text
hydrooj-plugins/
  01-homepage-frontend/
  02-account-interaction/
  03-domain-user-management/
  04-course-learning/
  05-problem-solution/
  06-contest-rating/
  07-content-system/
  90-local-disabled/          # 可选：暂存当前独有但暂不启用的插件
  plugins.catalog.json        # 后续建议新增：插件清单与启用状态
  scripts/
    generate-addon-json.ts    # 后续建议新增：按清单生成线上 addon.json
```

核心原则：

- `hydrooj-plugins` 里的线上插件默认可信。
- `hydroplugin` 独有插件先归档，不默认启用。
- 同功能不同名的插件只保留一个线上启用版本。
- 嵌套副本不要启用，后续清理或移动到 `archive/`。

## 线上仓库应作为基线的插件

这些插件建议直接以 `hydrooj-plugins` 版本为准：

| 插件 | 作用 | 处理 |
| --- | --- | --- |
| `extension` | Hydro plus / 前端增强类扩展。 | 保留线上版。 |
| `frontend` | 33OJ/HYOI 前端模板、资源、导航和页面覆盖。 | 保留线上版；不要和 `frontend-33oj`、`frontend-bpjudge` 同时启用。 |
| `hydro-float-widget` | 首页/站点浮窗通知组件。 | 保留线上版；当前版本有 `yarn.lock` 差异，合并时统一依赖文件。 |
| `hydro-scratchpad-editor-theme` | Scratchpad 编辑器主题增强。 | 导入并默认跟随线上启用状态。 |
| `user-background` | 用户可选背景图功能，线上版版本更高。 | 用线上版 `0.2.2`，再确认是否包含管理端上传图功能。 |
| `badge` | 徽章系统。 | 用线上版；当前 `badge-33oj` 作为旧版/开发版归档。 |
| `coin` | 金币、兑换、记录、商城相关。 | 用线上版；当前 `coin-33oj` 作为旧版/开发版归档。 |
| `hydrooj-domain-register-guide` | 域内注册引导/提示。 | 导入线上版。 |
| `hydro-domain-user-grade` | 域用户年级/分组扩展。 | 导入线上版。 |
| `users_manage` | 用户管理/实名类插件。 | 保留线上版；和 `realname`、用户导入类插件分开启用。 |
| `hydrooj-course` | 线上课程插件。 | 作为线上课程基线；当前课程 ATR 系列先不要覆盖它。 |
| `hydrooj-rich-objective-kit` | 客观题/填空题增强渲染与作答逻辑。 | 必须纳入主仓库，后续考试/selfeval 依赖它。 |
| `download-first` | 下载优先/题目资源下载相关增强。 | 用线上版；本地版逻辑更短，需确认是否有旧行为依赖。 |
| `hydrooj-contest-bulk-submit` | 比赛 ZIP 批量提交，支持管理员导入选手代码。 | 用线上版目录名和包名；本地 `index.ts` 与线上基本一致，保留线上 README。 |
| `hydrooj-contest-flexible-start` | 比赛显式开赛/灵活开始控制。 | 导入线上版。 |
| `contest-pdf` | 比赛题面 PDF 导出。 | 用线上版模板结构；注意保留客观题渲染修复。 |
| `hydrooj-contest-vp-mode` | Codeforces 风格 VP。 | 用线上版；当前仓库有两个副本，只保留一个。 |
| `hydro-hide-objective-score` | 隐藏客观题分数/成绩显示。 | 导入线上版。 |
| `hydro-live-board` | 实时榜单/大屏。 | 导入线上版。 |
| `hydrooj-contest-summary` | 赛后总结/讲评收集。 | 用线上版；它包含线上每日限制相关改动。 |
| `hydro-discussion-search` | 讨论搜索。 | 导入线上版。 |

## 当前项目独有插件

下面是 `hydroplugin` 中有、线上导出的 `hydrooj-plugins` 中没有的插件。建议先收进新仓库，但默认不启用。

### 首页与前端

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `ac-celebration` | AC 后在记录/题目详情页显示庆祝图片。 | 中；有多个副本，且会改记录详情模板。 | 只保留一个副本，默认关闭。 |
| `hydrooj-countdown` | 站点倒计时组件。 | 低。 | 可放入 `01-homepage-frontend`，默认关闭。 |
| `frontend-33oj` | 旧 33OJ 前端资源和模板覆盖。 | 高；和线上 `frontend` 同类。 | 不启用，只作为历史版本归档。 |
| `frontend-bpjudge` | BPJudge 前端模板覆盖，包含洛谷式难度渲染逻辑。 | 高；会覆盖导航、用户页、题目默认模板等。 | 单独归档；难度逻辑可以拆成独立功能，不整体启用。 |
| `swiper` | 首页轮播图。 | 中；可能和 `frontend` 首页模板冲突。 | 默认关闭，需要时再接入线上前端。 |
| `turtle-display` | GOC/Turtle 绘图题支持，注册 `cc.goc`，记录 EPS 转 PNG 预览。 | 中；会修改语言配置和评测输出展示。 | 独立保留，只有开 GOC 课程时启用。 |

### 账号与交互

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `badge-33oj` | 旧徽章管理模块。 | 高；和线上 `badge` 同功能。 | 不启用；必要功能对比后迁到线上 `badge`。 |
| `checkin-33oj` | 签到功能。 | 中；可能和金币/积分联动。 | 默认关闭，若启用需检查是否依赖 `coin-33oj`。 |
| `coin-33oj` | 旧金币模块，含金币记录、兑换、商城等。 | 高；和线上 `coin` 同功能。 | 不启用；只抽取线上缺失功能。 |
| `@hydrooj/rating-system` | 用户 rating 排名和历史。 | 中；和比赛 rating 插件可能重叠。 | 单独归档，和 contest rating 系列互斥测试。 |
| `@hydrooj/profile-lock` | 锁定/重置用户资料字段。 | 低到中；会拦截用户资料修改。 | 可保留，默认关闭。 |
| `pastebin-33oj` | 代码/文本粘贴板。 | 低。 | 可保留，默认关闭。 |
| `realname` | 实名/真实姓名模块。 | 中；和线上 `users_manage` 可能重叠。 | 默认关闭，迁移时优先使用线上 `users_manage`。 |

### 域与用户管理

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `hydrooj-class-team-hub` | 域内 2-3 人小组/教学队伍管理。 | 中；可能影响比赛组队插件。 | 保留，启用前和 ACM 小组榜联调。 |
| `hydrooj-domain-fold-groups` | 个人域分组折叠显示。 | 低。 | 可保留，默认关闭。 |
| `hydrooj-plugin-domain-nav-manager` | 域导航管理。 | 高；会改域导航入口。 | 和线上 `frontend` 联调后再启用。 |
| `hydrooj-plugin-zz-domain-nav-render-fix` | 域导航渲染修复。 | 高；依赖上面的导航管理实现。 | 作为补丁跟随 `domain-nav-manager`，不要单独启用。 |
| `hydrooj-domain-student-admin` | 域内学生账号导入/管理。 | 中；和线上 `users_manage`、用户导入插件重叠。 | 默认关闭，迁移时确定唯一入口。 |
| `hydrooj-domain-student-visibility` | 域内隐藏题库、统计、难度、标签等。 | 中；会影响学生可见性。 | 可保留，启用前检查与难度插件、题库页模板冲突。 |
| `hydrooj-domainUserData` | 域用户在线时长、提交、博客、比赛表现统计。 | 中；有两个副本且包含编译产物。 | 只保留源码版或线上需要版，不启用编译压缩副本。 |
| `@hydrooj/group-batch-manage` | 批量加入/移除域小组用户。 | 低。 | 可保留，默认关闭。 |
| `onlineuser-bpjudge` | 在线用户和近 24 小时活动查看。 | 中；会写 heartbeat/presence。 | 默认关闭，确认索引和写入压力后再启用。 |
| `@hydrooj/userimport-domain` | 扩展用户导入，支持 domain/role 列。 | 中；和线上 `users_manage`、学生导入重叠。 | 默认关闭，确定导入入口后只启用一个。 |

### 课程与学习

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `hydrooj-code-streak-flame` | 提交连续打卡火焰卡片和排行榜。 | 低到中；会读取提交数据。 | 可保留，默认关闭。 |
| `hydrooj-contest-acm-group-roll` | ACM 小组榜冻结和赛后滚榜。 | 中；当前有两个副本。 | 只保留一个副本，默认关闭。 |
| `hydrooj-article-kkkw` | 课程/文章训练系统 ATR 主体。 | 高；和线上 `hydrooj-course` 同属课程主功能。 | 不直接启用，先作为旧课程系统归档。 |
| `hydrooj-course-atr-exam-mode` | 课程 ATR 的考试模式。 | 高；依赖 ATR 主体。 | 跟随 ATR 归档，不单独启用。 |
| `hydrooj-course-lecture-problem` | 把课程小节中的一道题标记为讲义题，不计分。 | 中；依赖课程结构。 | 若继续用 ATR 课程再启用。 |
| `hydrooj-course-package` | 可复用课程包模块。 | 高；有多个嵌套副本。 | 只保留一个正式副本，其它嵌套副本归档。 |
| `hydrooj-course-summary-points` | 课程总结任务、教师审核和知识点沉淀。 | 中；当前有未提交改动。 | 保留本地版本，启用前先整理未提交改动。 |
| `hydrooj-plugin-course-unlock-rule` | 课程解锁规则。 | 中；依赖课程系统。 | 跟随课程系统选择。 |
| `hydrooj-course-video-vod` | 腾讯云 VOD 课程视频库。 | 低到中；依赖外部配置。 | 保留，默认关闭。 |
| `hydrooj-intro-blank-kit` | 程序填空练习，学生填空后拼成完整代码提交评测。 | 中；和客观题/填空题体验相关。 | 保留，后续和 `rich-objective-kit` 统一交互。 |
| `hydrooj-mistake-reflection` | 错题反思卡片和教师错题分析。 | 中；读写学习数据。 | 保留，默认关闭。 |
| `hydrooj-peer-summary-hub` | 优秀总结展示和同伴反馈。 | 中；和课程总结插件相关。 | 保留，默认关闭。 |

### 题目与题解

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `copy-solution` | 复制题目时同步复制题解。 | 中；会影响题目复制行为。 | 可保留，默认关闭，启用前测题目复制。 |
| `disable_sol` | 支持禁用/隐藏题解。 | 中；和课程 ATR 内题解开关有关。 | 如果线上需要题解开关，优先做成独立明确版本。 |
| `hydrooj-exportEx` | 题目导出记录和导出时附带题解。 | 中；会 hook 题目下载。 | 可保留，默认关闭。 |
| `hydrooj-problemQA` | 题目问答/答疑模块。 | 中。 | 保留，默认关闭。 |
| `problem-batch-pid` | 批量生成/调整题号 PID。 | 中；会改题目编号。 | 管理工具类，默认关闭或仅管理员安装。 |
| `problem-collection` | 学生个人题单收藏。 | 低到中。 | 保留，默认关闭。 |
| `hydrooj-problem-duplicate-detector` | 题目重复/相似题扫描。 | 低；管理工具。 | 保留，默认关闭。 |
| `problem-fast-io` | 题目快速导入/导出 ZIP，含数据、附加文件、题解。 | 中；和 Hydro 原生导入导出重叠。 | 管理工具类，默认关闭。 |
| `problem-reference` | 引用题目内容和题解。 | 中；会改题目详情和题解页面。 | 保留一个正式副本，嵌套副本归档。 |
| `hydrooj-problem-title-guard` | 创建/导入题目时检查重名标题。 | 低。 | 可保留，默认关闭。 |
| `problem-vote-bpjudge` | 题目投票。 | 低到中。 | 保留，默认关闭。 |
| `hydrooj-problem-zip-replace` | 用 ZIP 替换题目，保留原 pid/docId，支持批量匹配。 | 中；管理工具。 | 可保留，默认关闭。 |
| `hydrooj-sol2image` | 将题解渲染成图片存储展示。 | 中；会改题解内容展示。 | 与 `problem-reference` 联调后再启用。 |
| `@hydrooj/std-time-calibrator` | 用标程实测校准题目时限/内存并写回配置。 | 中；会发隐藏评测并修改 config。 | 管理工具类，默认关闭。 |

### 比赛与 rating

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `hydrooj-plugin-codeforces-round-rule` | 新增 Codeforces Round 赛制，按时间和罚次动态计分。 | 高；注册新比赛规则。 | 保留，启用前单独测试榜单和状态重算。 |
| `contestBulkSubmit` | 本地旧包名的比赛批量提交。 | 中；线上已有 `hydrooj-contest-bulk-submit`。 | 不启用旧包名；用线上目录，保留当前逻辑差异。 |
| `hydrooj-contest-acm-group-roll` | ACM 小组赛后滚榜。 | 中；重复副本。 | 只保留一个。 |
| `hydrooj-contest-fun-kit` | 比赛目标、任务卡、亮点、小组模式、复盘时间线。 | 中到高；会改比赛页体验。 | 默认关闭，和线上比赛模板联调。 |
| `hydrooj-contest-rating-arena` | 小班 Codeforces 风格 rating。 | 中到高；和 rating 系列重叠。 | 默认关闭，和 `rating-system`/`rating-season` 只选一套主线。 |
| `contest-solution` | 比赛题解页面和附件上传。 | 中；和 `contest-solution-pdf` 相关。 | 保留，默认关闭。 |
| `hydrooj-plugin-contest-solution-pdf` | 导出比赛题解 PDF。 | 中；依赖题解和题目文件链接。 | 跟随 `contest-solution`。 |
| `@hydrooj/contest-userimport` | 比赛批量加人。 | 中；和用户导入、批量提交有交集。 | 管理工具类，默认关闭。 |
| `hydrooj-rating-season` | rating 赛季视图和成长榜。 | 中；和其他 rating 插件重叠。 | 默认关闭，后续统一 rating 数据口径。 |

### 内容系统

| 插件 | 作用 | 冲突风险 | 处理 |
| --- | --- | --- | --- |
| `announce-bpjudge` | 公告模块。 | 中；可能和 `hydro-float-widget` 都做公告入口。 | 不优先启用，若用浮窗就先不用它。 |
| `hydrooj-history` | 每日备份用户 RP/提交/通过历史，并在用户页展示历史。 | 中；会创建索引和每日任务。 | 默认关闭，启用前确认 Mongo 权限和索引创建策略。 |
| `hydrooj-plugin-switch-center` | 插件运行时开关中心。 | 中到高；会影响插件启停策略。 | 可作为未来管理工具，但迁移第一阶段不启用。 |

## 当前项目中的嵌套副本/残留

这些路径看起来是插件目录里又嵌入了另一个插件，不建议作为独立插件启用：

```text
02-account-interaction/badge-33oj/ac-celebration-bpjudge
02-account-interaction/coin-33oj/ac-celebration-bpjudge
02-account-interaction/coin-33oj/hydrooj-rating-system-main
02-account-interaction/pastebin-33oj/problem-reference
03-domain-user-management/onlineuser-bpjudge/course-package
05-problem-solution/disable_sol/domain-userData
05-problem-solution/problem-batch-pid/course-package
06-contest-rating/contest-fun-kit/contest-fun-kit
```

处理建议：

- 不加入 `addon.json`。
- 如果里面有源码价值，移动到 `archive/nested-copies/`。
- 如果只是旧拷贝，后续删除。
- 在 `plugins.catalog.json` 里不要登记这些路径。

## 高风险冲突清单

| 冲突组 | 风险 | 处理方案 |
| --- | --- | --- |
| `frontend` vs `frontend-33oj` vs `frontend-bpjudge` | 都会覆盖核心模板、导航、用户页、题目页。 | 线上启用 `frontend`；从 `frontend-bpjudge` 只拆出难度渲染，不整体启用。 |
| `badge` vs `badge-33oj` | 同类徽章系统，数据模型和模板可能不同。 | 线上启用 `badge`；旧版归档。 |
| `coin` vs `coin-33oj` | 同类金币系统，可能写同类集合/页面入口。 | 线上启用 `coin`；旧版只抽功能。 |
| `users_manage` vs `realname` vs `domain-student-admin` vs `userimport-domain` | 都涉及用户资料、实名、导入和域角色。 | 先保留线上 `users_manage`；其它作为管理工具按需启用。 |
| `hydrooj-course` vs ATR 课程插件组 | 都是课程主系统，路由和数据类型可能冲突。 | 迁移第一阶段用线上 `hydrooj-course`；ATR 系列归档。 |
| `rich-objective-kit` vs `intro-blank-kit` | 都涉及客观题/填空/学生作答体验。 | 以后统一设计为考试能力；短期只启用线上 `rich-objective-kit`。 |
| `contest-pdf` vs `contest-solution-pdf` | 都做 PDF，但一个是题面，一个是题解。 | 可以共存，但入口和模板命名要检查。 |
| `contest-bulk-submit` vs `contest-userimport` | 一个批量提交代码，一个批量加参赛人；流程相邻。 | 可以共存，但权限入口要清楚。 |
| `rating-system` vs `contest-rating-arena` vs `rating-season` | 多套 rating 口径可能互相覆盖展示。 | 先不启用本地 rating 系列，单独确定统一口径。 |
| `domain-nav-manager` vs `frontend` | 都可能控制域导航显示。 | 先启用 `frontend`，导航管理等新服务器试装后再开。 |

## 推荐合并步骤

1. 把 `hydrooj-plugins` 作为主仓库，不再从 `hydroplugin` 整体覆盖线上插件。
2. 在主仓库新增 `plugins.catalog.json`，每个插件登记：

```json
{
  "id": "hydrooj-rich-objective-kit",
  "packageName": "hydrooj-rich-objective-kit",
  "path": "04-course-learning/rich-objective-kit",
  "source": "production",
  "productionEnabled": true,
  "notes": "线上已启用，客观题/填空题核心插件"
}
```

3. 把当前独有插件复制进主仓库，但全部标记：

```json
{
  "source": "local-only",
  "productionEnabled": false
}
```

4. 对高风险冲突组只启用一个主版本：
   - 前端：`frontend`
   - 徽章：`badge`
   - 金币：`coin`
   - 用户管理：`users_manage`
   - 课程：`hydrooj-course`
   - 客观题：`hydrooj-rich-objective-kit`
   - 批量提交：`hydrooj-contest-bulk-submit`

5. 写脚本从 `plugins.catalog.json` 生成 Hydro `addon.json`，不要手工维护启用列表。
6. 新服务器迁移时先只安装 `productionEnabled: true` 的线上基线插件。
7. 再按功能逐个打开本地独有插件，每开一个做一次重启和页面烟测。

## 第一阶段不建议启用的插件

第一阶段迁移只求和当前线上一致，下面这些即使收进仓库，也先不要启用：

```text
frontend-33oj
frontend-bpjudge
badge-33oj
coin-33oj
hydrooj-article-kkkw
hydrooj-course-atr-exam-mode
hydrooj-plugin-course-unlock-rule
hydrooj-plugin-codeforces-round-rule
hydrooj-contest-rating-arena
@hydrooj/rating-system
hydrooj-rating-season
hydrooj-plugin-switch-center
hydrooj-history
domain-nav-manager
domain-nav-render-fix
```

这些不是没用，而是它们会改核心页面、比赛规则、课程模型、用户数据或索引任务。迁移阶段先不要把变量开太多。
