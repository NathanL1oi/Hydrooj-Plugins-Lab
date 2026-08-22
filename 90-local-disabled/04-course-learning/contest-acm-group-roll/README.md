# hydrooj-contest-acm-group-roll

Hydro XCPC/ACM 比赛的小组榜、封榜和赛后滚榜插件。

> 该目录是课程分类下的同名副本。比赛相关插件建议以 `06-contest-rating/contest-acm-group-roll` 作为主维护位置。

## 功能

- 新增 `XCPC 小组榜设置` 页面：`/contest/:tid/acm-group/settings`。
- 新增 `XCPC 小组榜` 页面：`/contest/:tid/acm-group`。
- 新增 `XCPC 滚榜` 页面：`/contest/:tid/acm-group/roll`。
- 默认复用 `contest-fun-kit` 的小组参赛名单，也可选择班级小队、Hydro 域小组或手动名单。
- XCPC 排名规则：按小组统计通过题目的并集，同一小组内多人通过同一题只算一次；通过题数降序，罚时升序；罚时为首个小组 AC 分钟加首个小组 AC 前错误提交数乘罚时分钟。
- 访问官方 `Scoreboard` 时，XCPC 比赛会直接显示小组聚合榜；`VP`、`HTML`、`CSV`、`Ghost` 等其他视图保留原逻辑。
- 滚榜页提供展示台、榜单队列、全屏展示、自动或手动下一组，并按封榜后变化逐组生成最终榜。

## 安装

```powershell
hydrooj addon add .\04-course-learning\contest-acm-group-roll
```

安装后重启 Hydro。
