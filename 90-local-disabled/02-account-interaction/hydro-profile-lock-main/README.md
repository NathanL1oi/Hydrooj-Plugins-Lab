# hydro-profile-lock

Hydro OJ 插件：锁定用户个人信息字段，禁止用户自行修改，并提供一键重置功能。

## 安装

将插件目录放置到服务器上，然后执行：

```bash
hydrooj addon add /path/to/hydro-profile-lock
pm2 restart hydrooj
```

## 使用

安装后进入 Hydro 管理后台，左侧菜单会出现「个人信息锁定」，或直接访问 `/manage/profile-lock`。

在管理页面中可以：

- 开启/关闭锁定功能
- 开启/关闭拦截日志
- 查看当前锁定的字段列表
- 一键重置所有用户的个人信息（头像、昵称、简介、背景图等）

## 默认锁定字段

`avatar` `bio` `qq` `gender` `school` `studentId` `phone` `backgroundImage` `displayName`

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 是否启用锁定 |
| `log` | boolean | `true` | 是否记录拦截日志 |
| `fields` | string[] | 见上方列表 | 锁定的字段列表 |
| `reset.backgroundImage` | string | `/components/profile/backgrounds/1.jpg` | 重置时使用的背景图路径 |

## 相关项目

- [Hydro OJ](https://github.com/hydro-dev/Hydro)

## 许可证

AGPL-3.0-only（与 Hydro 主仓库一致）
