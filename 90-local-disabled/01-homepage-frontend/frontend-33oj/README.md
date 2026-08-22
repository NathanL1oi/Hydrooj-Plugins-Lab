# frontend-33oj

33OJ 风格的 Hydro 前端模板与静态资源覆盖插件。它不注册新路由，也不修改后端业务逻辑，主要通过覆盖模板和公共资源，把站点首页、训练、作业、榜单、用户页、页脚和榜单片段调整为 33OJ 使用的展示样式。

## 适用场景

- 希望 Hydro 站点整体使用 33OJ 的图标、页脚和部分页面布局。
- 希望首页侧栏增加“最近题目”和“自定义链接分组”展示。
- 希望训练列表、作业详情、排名页、用户详情页等页面展示更贴合 33OJ 的字段和排版。
- 已经在站点中使用 33OJ 自定义用户字段，例如实名信息、QQ、微信等。

如果只是想增加一个独立首页组件，而不想覆盖全站模板，不建议安装本插件；它属于模板覆盖型插件。

## 前置插件

本插件的 `package.json` 没有声明自动依赖，Hydro 安装时不会自动安装其他插件。但如果要获得 33OJ 完整展示效果，建议先安装下面这些插件，再安装 `frontend-33oj`：

| 插件 | 建议级别 | 作用 |
| --- | --- | --- |
| `realname` | 必装/强烈建议 | 提供 `realname_flag`、`realname_name`，并补全用户列表渲染时需要的 `displayName`。训练详情、用户详情等页面会用到这些字段。 |
| `badge-33oj` | 按需安装 | 提供 `udoc.badge` 的创建、展示、管理和删除能力。未安装时用户页只是不会显示自定义徽章。 |
| `hydro-profile-lock-main` | 可选 | 可批量重置或锁定头像、QQ、背景图、展示名等资料字段。`frontend-33oj` 可以读取这些字段，但不依赖它才能运行。 |

推荐安装顺序：

```bash
hydrooj addon add /path/to/hydroplugin/02-account-interaction/realname
hydrooj addon add /path/to/hydroplugin/02-account-interaction/badge-33oj
hydrooj addon add /path/to/hydroplugin/01-homepage-frontend/frontend-33oj
```

如果你的站点不使用实名或徽章，也可以只安装 `frontend-33oj`，但用户详情页中的对应区域会缺失或退回默认显示。

## 功能概览

- 覆盖基础 HTML 布局 `layout/html5.html`，加入 33OJ favicon、Apple Touch Icon、Android Chrome Icon、`theme-color` 和基础圆角样式。
- 提供 `nav_logo.png`、多尺寸 favicon、移动端图标等静态资源。
- 覆盖页脚 `partials/footer.html`，保留评测队列、服务状态、兼容模式切换、主题切换等链接，并显示 Hydro 版本和 `Modified by 33DAI` 标识。
- 覆盖训练列表页 `training_main.html` 和训练列表片段 `partials/training_list.html`，显示完成情况、训练计划名称、章节/题目数量、参加人数。
- 覆盖训练详情页 `training_detail.html`，保留报名、编辑、文件、帮助等操作入口，并支持按训练成员或分组查看进度。
- 覆盖作业详情页 `homework_detail.html`，集中展示作业介绍、题目列表、提交状态和最后提交时间。
- 覆盖排名页 `ranking.html`，展示排名、用户、RP、各项 RP 明细和 AC 数。
- 覆盖用户详情页 `user_detail.html`，展示 UID、实名/展示名、注册与活跃时间、AC/RP、联系方式、通过题目列表和题目标签统计。
- 覆盖比赛/作业榜单片段 `partials/scoreboard.html`，显示冻结提示、用户分组、题目通过/提交数和按分数着色的记录。
- 提供首页侧栏片段：
  - `recent_problems`：显示最近公开题目。
  - `sidebar_nav`：显示自定义链接分组。
- 覆盖 `partials/problem_default.md`，作为新建题目时的默认题面片段。

## 安装

在 Hydro 服务器上执行。完整 33OJ 使用场景建议先按“前置插件”安装相关账号插件，再安装本插件：

```bash
hydrooj addon add /path/to/hydroplugin/01-homepage-frontend/frontend-33oj
```

如果你已经进入插件目录，也可以执行：

```bash
hydrooj addon add .
```

安装完成后，按你的部署方式重启 Hydro。例如：

```bash
pm2 restart hydrooj
```

或在 Docker 部署中重启对应容器：

```bash
docker compose restart
```

重启后刷新浏览器。如果启用了 CDN、反向代理缓存或浏览器强缓存，建议清理缓存后再检查 favicon、Logo 和模板效果。

## 首页配置

本插件提供两个首页模板片段：`recent_problems` 和 `sidebar_nav`。在系统设置的 `hydrooj.homepage` YAML 中加入对应配置后，Hydro 会把配置作为 `payload` 传给模板并渲染。

示例：

```yaml
- width: 9
  bulletin: true
  contest: 5
  homework: 10
  training: 10
- width: 3
  recent_problems: 10
  sidebar_nav:
    - title: 常用链接
      urls:
        - name: 学校官网
          url: https://example.com
        - name: 课程安排
          url: /training
    - title: 竞赛相关
      urls:
        - name: 比赛列表
          url: /contest
        - name: 排名
          url: /ranking
```

字段说明：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `recent_problems` | 数字 | 最近题目数量。数据由 Hydro 原生最近题目逻辑提供，本插件只负责展示模板。 |
| `sidebar_nav` | 数组 | 自定义链接分组。每个分组会渲染为一个侧栏区块。 |
| `sidebar_nav[].title` | 字符串 | 链接分组标题。 |
| `sidebar_nav[].urls` | 数组 | 当前分组下的链接列表。 |
| `sidebar_nav[].urls[].name` | 字符串 | 链接显示名称。 |
| `sidebar_nav[].urls[].url` | 字符串 | 链接地址，可以是站内路径或完整 URL。 |

`sidebar_nav` 中的链接会以 `target="_blank"` 打开。外部链接请使用可信地址；站内链接建议使用 `/training`、`/contest`、`/ranking` 这类相对路径，方便迁移域名。

## 页面效果

### 全站布局

`templates/layout/html5.html` 会替换 Hydro 默认 HTML 外壳。它保留默认主题 CSS、Hydro 前端脚本、语言包、`UiContext` 和 `UserContext` 注入逻辑，同时把 favicon、移动端图标和 Open Graph 图片指向本插件的静态资源。

静态资源位于：

```text
public/nav_logo.png
public/favicon.ico
public/favicon-16x16.png
public/favicon-32x32.png
public/favicon-96x96.png
public/apple-touch-icon-180x180.png
public/android-chrome-192x192.png
```

如果你想替换站点 Logo 或图标，可以直接替换这些文件，文件名保持不变，然后重启 Hydro 或清理静态资源缓存。

### 页脚

页脚保留以下入口：

- 评测队列。
- 服务状态。
- 标准模式/兼容模式切换。
- Light/Dark 主题切换。
- 域级 `footer_extra_html` 和系统级 `ui-default.footer_extra_html`。
- 当前 Worker、页面耗时、Hydro 版本和 33DAI 修改标识。

### 训练列表页

训练列表会以表格方式展示：

- 当前用户完成情况。
- 训练计划名称。
- 章节数量和题目数量。
- 参加人数。

已登录用户还能在右侧看到已报名训练的进度条。拥有创建训练权限的用户会看到“新建训练计划”入口。

### 训练详情页

训练详情页会展示训练标题、内容、描述和题目列表，并在右侧显示：

- 报名训练按钮。
- 编辑入口。
- 文件入口。
- 帮助入口。
- 当前用户报名状态、完成进度、参加人数、创建者。

如果训练有报名用户，左侧会显示用户列表，并支持按分组筛选或输入用户查看对应进度。

### 作业详情页

作业详情页会展示：

- 作业标题。
- 作业介绍。
- 题目列表。
- 当前用户提交状态。
- 最后提交时间。

如果作业题目尚不可见，会根据领取状态显示对应提示。

### 排名页

排名页会展示：

- 排名。
- 用户名。
- 总 RP。
- Hydro 中未隐藏的各项 RP 明细。
- AC 数。

登录用户会在列表顶部看到自己的当前排名、RP 明细和 AC 数。

### 用户详情页

用户详情页会展示：

- 头像和个人背景图。
- UID。
- 用户名、展示名或实名。
- 自定义徽章。
- 注册时间、最近登录时间、最近活跃时间。
- 已通过题目数、RP 和排名。
- 私信、邮箱、QQ、微信、性别、SU/MOD 标识。
- 已通过题目列表。
- 提交数、通过数、题解点赞数。
- 题目标签统计。

该页面使用了 33OJ 自定义字段。详见“自定义字段依赖”。

### 榜单片段

`partials/scoreboard.html` 会影响比赛榜单和作业榜单中复用该片段的页面。它会：

- 在封榜时展示冻结提示。
- 在题目列显示题目 AC/提交数。
- 支持星标用户按钮。
- 在用户名后展示用户所在分组。
- 使用 Hydro 的 `utils.status.getScoreColor()` 按分数给记录着色。
- 根据权限决定记录是否可点击进入详情。

## 自定义字段依赖

本插件可以在普通 Hydro 实例上安装，但用户详情页中部分信息依赖 33OJ 自定义字段或前置插件。如果这些字段不存在，对应区域可能为空、显示默认分支，或不展示。

常见字段包括：

| 字段 | 用途 |
| --- | --- |
| `udoc.realname_flag` | 实名状态图标。`1` 显示星标图标，`2` 显示用户图标。通常由 `realname` 提供。 |
| `udoc.realname_name` | 有权限时显示的实名。通常由 `realname` 提供。 |
| `udoc.displayName` | 有权限时显示的展示名。`realname` 会补全用户列表渲染时的展示名。 |
| `udoc.mail` | 邮箱复制入口。 |
| `udoc.qq` | QQ 复制入口。 |
| `udoc.wechat` | 微信复制入口。 |
| `udoc.backgroundImage` | 用户主页背景图。 |
| `udoc.badge` | 自定义徽章，格式为 `文本#背景色#文字色`，通常由 `badge-33oj` 提供。 |

## 覆盖文件清单

```text
templates/layout/html5.html
templates/user_detail.html
templates/training_main.html
templates/training_detail.html
templates/homework_detail.html
templates/ranking.html
templates/partials/footer.html
templates/partials/scoreboard.html
templates/partials/training_list.html
templates/partials/homepage/recent_problems.html
templates/partials/homepage/sidebar_nav.html
templates/partials/problem_default.md
public/*
```

插件入口 `index.ts` 只是占位入口：

```ts
export function apply(_ctx: Context) {
    // Template and public asset override plugin.
}
```

也就是说，它的主要行为来自 Hydro 的模板和静态资源覆盖机制，而不是 TypeScript 后端逻辑。

## 更新

如果插件目录来自本仓库，更新仓库后重启 Hydro：

```bash
git pull
pm2 restart hydrooj
```

如果你的部署流程会把插件复制到 Hydro addon 目录，而不是直接引用当前目录，请在更新后重新安装插件：

```bash
hydrooj addon remove /path/to/hydroplugin/01-homepage-frontend/frontend-33oj
hydrooj addon add /path/to/hydroplugin/01-homepage-frontend/frontend-33oj
```

然后重启 Hydro。

## 卸载

执行：

```bash
hydrooj addon remove /path/to/hydroplugin/01-homepage-frontend/frontend-33oj
```

然后重启 Hydro。卸载后，相关页面会恢复为其他插件或 Hydro 默认模板提供的版本。

## 兼容性与注意事项

- 本插件会覆盖全站基础布局和多个核心页面模板，不建议与其他同样覆盖这些模板的前端皮肤插件同时安装。
- 如果必须同时安装多个模板覆盖插件，最终效果取决于 Hydro 的插件加载顺序和同名模板优先级。
- 与本插件冲突风险较高的文件包括 `layout/html5.html`、`partials/footer.html`、`user_detail.html`、`ranking.html`、`training_main.html`、`training_detail.html`、`homework_detail.html` 和 `partials/scoreboard.html`。
- 本插件没有提供额外权限控制，页面是否能看到数据仍由 Hydro 原有权限和对应页面 handler 决定。
- 用户详情页默认隐藏 Bio 内容，展示通过题目和统计信息。如果需要展示用户自定义 Bio，需要调整 `templates/user_detail.html`。
- `sidebar_nav` 链接直接渲染配置内容。配置外部链接时请确认链接可信。

## 常见问题

### 安装后页面没有变化

确认插件已经被 Hydro 加载，并重启 Hydro。然后检查是否有其他插件覆盖了相同模板。如果仍然没有变化，清理浏览器缓存或 CDN 缓存后再试。

### favicon 或 Logo 没有更新

浏览器会强缓存 favicon。可以尝试强制刷新、清理浏览器缓存，或临时换一个浏览器访问。反向代理或 CDN 开启缓存时，也需要清理对应缓存。

### 首页没有显示最近题目

确认 `hydrooj.homepage` 中写入了 `recent_problems`，并且当前域存在可见的公开题目。如果题目不可见、被隐藏或权限不足，最近题目区域可能不会渲染。

### 首页没有显示自定义链接

确认 `sidebar_nav` 是数组格式，并且每个分组都有 `title` 和 `urls`。每个链接项需要包含 `name` 和 `url`。

### 用户页实名信息为空

这些信息依赖 33OJ 自定义字段。普通 Hydro 用户文档里没有对应字段时，模板只能显示默认分支。可以补齐字段、安装对应功能插件，或修改 `user_detail.html` 删除相关展示。

### 与其他前端插件样式冲突

优先检查是否存在同名模板覆盖。对于强覆盖型前端插件，最稳妥的做法是把需要的模板改动合并到一个插件中，而不是让多个插件同时覆盖同一文件。
