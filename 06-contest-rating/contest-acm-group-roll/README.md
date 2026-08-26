# hydrooj-contest-acm-group-roll

Hydro XCPC/ACM 比赛的小组榜、封榜和赛后滚榜插件。

## 功能

- 新增 `XCPC 小组榜设置` 页面：`/contest/:tid/acm-group/settings`。
- 新增 `XCPC 小组榜` 页面：`/contest/:tid/acm-group`。
- 新增 `XCPC 滚榜` 页面：`/contest/:tid/acm-group/roll`。
- 默认复用 `contest-fun-kit` 的小组参赛名单，也可选择班级小队、Hydro 域小组或手动名单。
- XCPC 排名规则：按小组统计通过题目的并集，同一小组内多人通过同一题只算一次；通过题数降序，罚时升序；罚时为首个小组 AC 分钟加首个小组 AC 前错误提交数乘罚时分钟。
- 访问官方 `Scoreboard` 时，XCPC 比赛会直接显示小组聚合榜；管理员可在设置页单独配置小组来源、封榜时间和罚时。
- 学生端比赛中也显示小组榜；进入封榜期后固定展示冻结时刻之前的结果，排名不再更新；结束后开放最终榜和滚榜。
- 小组榜沿用 Hydro 原比赛成绩表样式，表格行以小组名替换用户名称，题目列、颜色、封榜提示和工具栏风格保持一致。
- 滚榜页提供展示台、榜单队列、全屏展示、自动或手动下一组，并按封榜后变化逐组生成最终榜。
- 官方 `/contest/:tid/scoreboard` 默认成绩表会被替换为小组榜；`VP`、`HTML`、`CSV`、`Ghost` 等其他视图保留原逻辑。

## 安装

```powershell
hydrooj addon add .\06-contest-rating\contest-acm-group-roll
```

安装后重启 Hydro。
