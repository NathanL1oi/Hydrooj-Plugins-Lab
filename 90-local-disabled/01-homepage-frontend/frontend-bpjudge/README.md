# frontend-bpjudge

BPJudge 风格前端增强插件。它同时包含模板覆盖、用户渲染增强、用户等级配色，以及题目难度显示增强。

## 功能

- 覆盖顶部导航模板，支持和 `domain-nav-manager` 类似的主导航/更多导航拆分。
- 顶部导航使用系统设置中的 `ui-default.nav_logo_dark` 作为站点 Logo。
- 覆盖页脚模板，加入在线用户入口、语言切换、主题切换、Hydro 版本与 BPJudge 修改标识。
- 覆盖用户内联渲染组件，根据用户等级、SU/MOD 权限和自定义徽章展示不同颜色。
- 覆盖用户详情页，展示头像背景、学校、注册时间、最近活跃时间、AC/RP、联系方式、通过题目和标签统计。
- 重写 `UserModel.getListForRender()`，优先读取真实用户、虚拟用户和域用户资料，并补全 `school`、`studentId`、`displayName`、`avatar` 等字段。
- 在系统用户权限页后处理用户列表，确保展示的是完整用户文档。
- 在前端注入等级颜色和徽章颜色样式。
- 在题目列表、训练详情和题目详情页渲染 `difficulty` 字段的中文难度。
- 在题目标签中独立渲染新版洛谷难度标签。
- 在题目创建/编辑页把难度输入框替换为中文难度下拉框。
- 启动时确保系统设置 `problem.categories` 中的“难度”标签组为新版洛谷 0 到 8 体系，保留其它标签分类不变。

## 难度规则

难度显示、标签识别、编辑页下拉框和分级标准见 [题目难度标注说明](./DIFFICULTY.md)。
插件会维护系统标签分类中的“难度”组为新版洛谷 0 到 8 体系；题目自身已有的难度标签数据不会在启动时自动批量重写。

## 生效页面

- `problem_main`：题目列表难度列渲染为中文彩色标签，题目标签中的难度独立渲染。
- `training_detail`：训练题目列表难度列渲染为中文彩色标签。
- `problem_detail`：题目详情页中的难度字段和难度标签分别渲染为中文彩色标签。
- `problem_create`、`problem_edit`：难度字段变为下拉框，不从标签自动同步。
- `user_detail`：用户主页模板覆盖。
- 全站导航、页脚、用户内联组件。

## 安装

```bash
hydrooj addon add /path/to/frontend-bpjudge
```

安装后重启 Hydro。

## 注意

- 这是强覆盖型前端插件，会覆盖 `partials/nav.html`、`partials/footer.html`、`components/user.html` 和 `user_detail.html`。
- 如果同时安装其他导航、页脚或用户组件插件，需要合并模板或调整加载顺序。
- 插件会 monkey patch `UserModel.getListForRender()`，不建议与其他改写相同模型方法的插件同时使用。
- `difficulty.page.ts` 只负责前端展示和表单交互；难度字段与难度标签不做自动同步。
- `index.ts` 只维护系统标签分类里的“难度”组，不会删除或覆盖其它分类。
