# hydrooj-plugin-zz-domain-nav-render-fix

域导航渲染兼容修复插件，用于配合 `domain-nav-manager` 稳定渲染顶部导航。

## 功能

- 按域读取 `domain.navManager` 配置，并缓存导航分区、排序和改名信息。
- 补齐虚拟导航节点注册与合并能力，避免插件注入的导航项在渲染时丢失。
- 提供主导航、更多菜单、隐藏三种分区的默认规则，并对课程入口、管理入口等常见项做兼容处理。
- 对导航项 `checker`、动态 `args` 和域 ID 推断做容错，减少页面上下文不完整时的导航渲染异常。

## 安装

```powershell
hydrooj addon add .\03-domain-user-management\domain-nav-render-fix
```

安装或更新后重启 Hydro。建议与 `domain-nav-manager` 一起使用。
