# hydrooj-contest-bulk-submit

Hydro 比赛批量提交插件。管理员可以在比赛页面上传 ZIP，插件会按用户名、题目标识或手动映射批量创建提交记录，并立即触发 judge。

## 功能

- 在比赛详情页注入“批量上传提交”入口。
- 提供 `/contest/:tid/bulk_submit` 管理页面。
- 支持上传 ZIP 压缩包并识别常见源码扩展名。
- 支持按“姓名 / 题号或 PID / 源文件”结构导入，也支持在页面上手动调整题目目录和源文件映射。
- 自动让未参赛用户加入比赛，并调用 Hydro 的评测接口提交 judge。

## 安装

```powershell
hydrooj addon add .\standalone-plugins\contest-bulk-submit
```

如果把插件目录复制到了其他位置，请把命令中的路径替换为实际路径。安装后重启 Hydro。

## 入口

- 比赛详情页侧边栏管理员入口。
- `/contest/:tid/bulk_submit`

## ZIP 结构建议

```text
submissions.zip
└── 张三
    ├── A
    │   └── main.cpp
    └── B
        └── solution.py
```

也可以使用题目 PID、题目交卷目录、源文件名等作为识别线索；页面中的“题目映射”可以覆盖默认识别规则。
