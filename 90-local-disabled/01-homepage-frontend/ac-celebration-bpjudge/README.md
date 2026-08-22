# AC Celebration BPJudge

AC 后的前端庆祝提示插件。它会在用户提交通过时弹出一张庆祝图片，适合给练习、题目详情页和评测记录详情页增加即时反馈。

## 功能

- 在系统设置中注册 `acImage.duration` 和 `acImage.url` 两个配置项。
- 默认使用插件自带图片 `/ac-congrats.png`，默认展示时间为 `3500ms`。
- 在题目详情页监听预评测 WebSocket，当当前登录用户的非比赛提交从非 AC 变为 AC 时弹出庆祝图。
- 在记录详情页监听当前记录状态，当当前登录用户的非比赛记录变为 AC 时弹出庆祝图。
- 弹窗使用 `sweetalert2`，背景透明、无确认按钮，时间结束后自动关闭。
- 后端会把图片地址、持续时间和当前记录信息写入 `UiContext`，前端页面脚本直接读取。

## 配置

安装并重启 Hydro 后，到系统设置中找到 `acImage` 分组：

- `acImage.url`：庆祝图片地址。可以使用插件自带 `/ac-congrats.png`，也可以填入站内静态资源或外部 HTTPS 图片。
- `acImage.duration`：图片展示时长，单位为毫秒。

示例：

```text
acImage.url = /ac-congrats.png
acImage.duration = 3500
```

## 生效页面

- `problem_detail`：题目详情页提交并等待结果时生效。
- `record_detail`：评测记录详情页等待当前记录完成时生效。

## 安装

```bash
hydrooj addon add /path/to/ac-celebration-bpjudge
```

安装后重启 Hydro，使后端设置项和前端页面脚本一起加载。

## 注意

- 插件只对当前登录用户自己的提交弹窗。
- 代码中会跳过比赛内提交，避免在比赛场景中干扰用户。
- 如果自定义图片地址不可访问，弹窗仍会触发，但图片不会正常显示。
- 若题目详情页没有可用的预评测连接，只有记录详情页的监听会生效。
