# hydrooj-contest-vp-mode

Codeforces 风格的 Hydro 比赛 VP 插件。

## 功能

- 比赛结束后，未正式参赛且属于比赛允许参赛小组的用户可以开启 VP。
- VP 使用个人开始时间和比赛灵活时长生成时间窗；未配置灵活时长时使用原比赛起止时长。
- VP 时间窗内可以继续使用原比赛题目的提交入口。
- VP 用户在原正式榜中保持 `unrank`，不挤占正式参赛排名。
- 新增 `VP 排名` scoreboard view，用相对时间重算 VP 成绩，并用 `VP` / `正式` 标记参赛类型。
- 学生在完成自己的 VP 前，不能查看 VP 排名，也不能查看普通比赛排名、导出榜或 Ghost 榜；比赛拥有者和有隐藏榜权限的管理员不受限制。

## 安装

```powershell
hydrooj addon add .\standalone-plugins\contest-vp-mode
```

安装后重启 Hydro。
