# 公告模块

`announce-bpjudge` 为 Hydro 增加独立公告系统，支持在域内发布公告、查看公告列表与详情，并将最新公告挂到首页区域。

## 功能

- 提供公告列表、公告详情、原始 Markdown 内容、创建、编辑和删除页面。
- 公告内容使用 Markdown 编辑与渲染，适合发布通知、课程安排、比赛说明等内容。
- 支持公告隐藏、置顶权重和高亮显示。
- 普通用户只能看到未隐藏公告；拥有域编辑权限的用户可以查看和维护隐藏公告。
- 首页处理器会暴露 `getAnnounce()`，供 `templates/partials/homepage/announce.html` 展示最新公告。
- 在顶部导航注册 `announce_main` 入口。

## 入口

- `/announce`：公告列表。
- `/announce/create`：创建公告。
- `/announce/:aid`：公告详情。
- `/announce/:aid/raw`：公告原始 Markdown。
- `/announce/:aid/edit`：编辑或删除公告。

## 权限

创建、编辑、删除公告需要 `PERM_EDIT_DOMAIN`。隐藏公告的详情和原始内容同样需要该权限才能访问。

## 配置

插件注册了系统设置：

```text
pagination.announce
```

该配置控制公告列表每页数量，默认值为 `10`。

## 数据

公告通过 Hydro 的 `DocumentModel` 保存，文档类型常量为 `TYPE_ANNOUNCE = 1000`。每条公告记录包含标题、正文、作者、隐藏状态、高亮状态、置顶权重、更新时间、浏览数字段等信息。

## 安装

将插件目录放入服务器插件目录后安装，例如：

```bash
hydrooj addon add /home/hydro-plugins/announce-bpjudge
```

安装或更新后重启 Hydro。
