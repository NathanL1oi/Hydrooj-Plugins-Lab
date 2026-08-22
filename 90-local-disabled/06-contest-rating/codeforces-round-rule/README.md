# Codeforces Round Rule

为 Hydro 注册一个新的比赛规则：`codeforces`。

## 计分规则

- 每题初始分默认按题目顺序使用 `500, 1000, 1500, 2000, 2500, ...`。
- 如果比赛里为某题设置了自定义分值，则以自定义分值作为该题初始分。
- AC 后单题得分：

```text
max(初始分 * 30%, 初始分 - 初始分 / 250 * 通过分钟数 - 50 * AC 前错误提交数)
```

- 总分为所有 AC 题目得分之和。
- 榜单中 AC 的单题分数按 Hydro 的通过色显示为绿色，显示的数值仍为实际 CF 得分。
- 榜单按总分降序排序，同分并列。

## 安装

```bash
hydrooj addon add C:\Users\kkkw\Desktop\hydro插件-59\02-新插件\codeforces-round-rule
```

安装后重启 Hydro。新建或编辑比赛时，在 Rule 下拉框中选择 `Codeforces Round`。

## 手动调整分数

创建 `Codeforces Round` 比赛后，比赛详情侧栏会出现 `CF 分数设置`。

在该页面可以逐题设置初始分。留空表示使用默认分；保存后插件会写入比赛的 `score` 字段，并调用 `ContestModel.recalcStatus` 重新计算已有提交和榜单。

## 说明

这个插件实现的是传统 Codeforces Round 的题目分数递减规则。Hack 阶段、房间内 lock 后互 hack、pretest/system test 双阶段属于后续插件能力，本插件先只补齐赛制计分层。
