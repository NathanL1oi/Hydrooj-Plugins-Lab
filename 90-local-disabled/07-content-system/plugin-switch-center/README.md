# 插件主控中心

`plugin-switch-center` 是 Hydro 插件总览与运行时开关页面，用于集中展示服务器插件清单、安装路径、入口规则和启停状态。

## 功能

- 统一展示当前安装的官方包和本地插件。
- 按分类、关键词和核心保护状态筛选插件。
- 自定义插件支持启用和停用开关。
- 停用后隐藏已登记的导航、域管理、比赛侧边栏、用户菜单入口。
- 停用后拦截已登记的插件路由访问。
- 官方核心包显示为“核心保护”，避免在运行中误关。
- 记录钩子类、前端类、定时任务类插件的开关状态，并向其他插件暴露同步查询接口。

## 入口

- `/manage/plugin-switch`
- `/manage/plugin-switch-center`
- `/plugin-switch`

只有 `system` 主域超管可以访问。页面也会出现在系统控制面板和超管头像下拉菜单中。

## 清单文件

插件说明来自当前目录下的 `plugins.json`。新增或移动插件时，通常只需要在该文件补充或调整清单项：

- `id`：插件开关使用的唯一标识。
- `title`：页面展示名称。
- `packageName`：插件包名。
- `category`：页面分组。
- `description`：功能说明。
- `serverPath`：服务器安装路径。
- `localPath`：仓库内相对路径。
- `routePatterns`：需要被开关拦截的路由正则。
- `uiNodes`：需要被隐藏的 UI 节点。
- `locked`：是否作为核心保护项，不允许运行时关闭。

## 接入方式

其他插件可以主动读取开关状态：

```ts
global.Hydro.model.pluginSwitch.isEnabledSync('intro-blank-kit')
```

如果插件注册了事件钩子、全局原型、定时任务或长期驻留逻辑，建议在自身 handler 或 hook 内主动检查该状态。

## 安装

将插件目录放入服务器插件目录后安装，例如：

```bash
hydrooj addon add /home/hydro-plugins/plugin-switch-center
```

安装或更新后重启 Hydro。

## 说明

这是运行时开关中心，不会删除插件文件，也不会改写 Hydro 的 addon 配置。路由型插件可以立即隐藏入口并拦截访问；已经注册到全局原型、事件钩子、前端资源或定时任务的插件，彻底停用仍建议重启 Hydro，或让对应插件主动接入本开关。
