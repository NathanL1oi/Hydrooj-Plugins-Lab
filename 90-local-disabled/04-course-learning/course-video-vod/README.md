# hydrooj-course-video-vod

Hydro 课程视频库插件，放在 `02 新构`，不修改 `01 已装`。

## 当前能力

- 控制面板入口：`/manage/course-video`
- 仅主域 Hydro 超管可上传、禁用、删除视频
- 视频文件通过浏览器直传腾讯云 VOD，不写入 Hydro 硬盘
- 上传页面显示 VOD 上传进度，完成后自动登记 VOD FileId
- Hydro 只保存 FileId、标题、分类、课程绑定等元数据
- 删除 VOD 视频时会同步调用腾讯云 DeleteMedia，删除云端媒体文件并清理课程绑定
- 支持视频分类：默认 `语法 / 入门 / 基础 / 提高 / 比赛-语法 / 比赛-入门`，也可新增分类
- 支持课程包节编辑页绑定讲解视频
- 支持课程小节页绑定和播放讲解视频
- 支持课程级“学生端显示视频”开关

## VOD 配置

在 `/manage/course-video/config` 填写：

- `AppId`：腾讯云账号 AppId，可空
- `VOD AppId / SubAppId`：VOD 应用 ID，使用子应用时填写 SubAppId
- `SecretId` / `SecretKey`：腾讯云 API 密钥，用于生成 VOD 上传签名
- `PlayKey`：播放密钥，可空；留空时插件会尝试通过 API 查询默认分发配置

上传完成后，腾讯云 VOD 控制台的“已上传”列表应该能看到视频。

## 安装

```powershell
hydrooj addon add "C:\Users\kkkw\Desktop\hydro\05\02 新构\course-video-vod"
```

安装或更新后重启 Hydro。
