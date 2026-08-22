# 用户历史统计

`hydrooj-history` 为 Hydro 用户详情页增加历史趋势图，并通过每日任务备份用户 RP、提交数和通过数等统计数据。

## 功能

- 每日备份各域用户的 RP、题目 RP、比赛 RP、累计 AC 数、当日提交数和当日新增 AC 数。
- 在用户详情页注入历史数据。
- 在用户页展示两个趋势页签：提交/通过统计和 RP 变化。
- 前端使用 ECharts 绘制折线图与柱状图。
- 自动建立历史记录查询索引，提升按用户和日期读取的效率。

## 展示位置

插件通过 `UserDetail#get` 后置钩子把历史记录写入页面响应，并由以下模板片段展示：

- `templates/partials/user_detail/history_stat.html`
- `templates/partials/user_detail/history_rating.html`

前端资源 `frontend/history.page.js` 会在用户详情页加载后渲染图表。

## 定时任务

插件注册脚本：

```text
backupRpInfo
```

同时监听 Hydro 的 `task/daily` 事件，每天自动运行一次备份。也可以在 Hydro 脚本系统中手动执行该脚本，用于初始化或补跑历史数据。

## 数据

历史记录保存在 MongoDB 的 `history` 集合中。单条记录包含：

- `time`：备份日期。
- `domainId`：所属域。
- `uid`：用户 ID。
- `rp`、`rpInfo`：总 RP 与分项 RP。
- `nAccept`：累计通过数。
- `nSubmit`：当日提交数。
- `newAccept`：当日通过数。

插件会为 `domainId + uid + time`、`time`、`domainId + time` 建立索引。

## 依赖

插件依赖 `echarts`，用于前端图表渲染。

## 安装

将插件目录放入服务器插件目录后安装，例如：

```bash
hydrooj addon add /root/.hydro/addons/hydrooj-history
```

安装或更新后重启 Hydro。首次安装后，需要等待每日任务运行，或手动执行 `backupRpInfo`，用户页才会出现足够的历史曲线数据。
