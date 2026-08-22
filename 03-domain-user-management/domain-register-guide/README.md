# Domain Register Guide

一个轻量的 Hydro 前端引导插件：在指定域里，对未登录用户显示“注册引导”按钮；点击后逐步高亮注册入口、邮箱、用户名、密码、重复密码和注册按钮。

插件不会代填信息，也不会自动提交表单，只负责引导学生按页面上的真实注册流程操作。

## 安装

在 `hydro-plugins` 仓库根目录执行：

```bash
hydrooj addon add .\community\domain-register-guide
```

安装或更新插件后重启 Hydro。

## 配置

```ts
{
  domainIds: ['hyoi'],
  buttonText: '注册引导',
  autoOpen: false,
}
```

- `domainIds`：启用引导的域 ID。默认只在 `hyoi` 域启用；设为空数组 `[]` 表示所有域都启用。
- `buttonText`：右下角浮动按钮文字。
- `autoOpen`：是否在用户第一次访问该域时自动弹出引导。默认关闭，只显示按钮。

## 行为

- 只对未登录用户展示。
- 只在配置命中的域展示。
- 如果系统关闭注册或当前访客没有注册权限，不展示按钮。
- 从任意页面点击引导，会先提示右上角注册入口。
- 在 `/register` 邮箱页，会提示填写邮箱并点击“发送验证邮件”。如果站点关闭邮箱验证，Hydro 会直接进入下一步。
- 在 `/register/:code` 注册信息页，会继续提示填写用户名、密码、重复密码并提交注册。
