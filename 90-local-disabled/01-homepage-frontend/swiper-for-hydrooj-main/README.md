# Swiper for HydroOJ

域级首页轮播图插件。它为每个域提供独立的轮播配置、图片素材管理页和首页展示模板，适合在首页顶部或侧栏展示公告图、活动入口、课程入口等内容。

## 功能

- 为 `HomeHandler` 增加 `getSwiper()`，首页配置中写入 `swiper` 后即可渲染。
- 在“管理域”侧栏注入 `轮播图` 配置入口。
- 注册 `/domain/swiper` 管理页，拥有域编辑权限的用户可以编辑当前域轮播。
- 每个域独立保存轮播配置，数据存储在 `swiper` 集合中。
- 支持配置是否循环播放、是否自动播放和自动播放间隔。
- 支持最多 20 个轮播项。
- 每个轮播项包含标题、图片地址和点击跳转地址。
- 管理页提供可视化表单、JSON 视图、轮播预览、添加/删除/上移/下移等操作。
- 支持上传图片素材到 Hydro Storage，图片按 `swiper/<domainId>/` 分域保存。
- 图片素材页支持查看、加入轮播和删除选中图片。
- 注册 `/domain/swiper/file/:filename`，用于安全访问当前域的轮播素材。
- 首页模板加载 `swiper-bundle.min.js` 和 `swiper-bundle.min.css`，提供分页点和左右切换按钮。
- 支持中英文 i18n 文案。

## 首页配置

在系统设置的 `hydrooj.homepage` 中加入 `swiper`：

```yaml
- width: 9
  swiper: true
  bulletin: true
  contest: 5
- width: 3
  recent_problems: 10
```

当当前域没有有效轮播项时，首页不会显示轮播区域。

## 管理入口

访问：

```text
/domain/swiper
```

也可以从“管理域”侧栏中的“轮播图”入口进入。

管理页支持：

- 编辑轮播标题、图片地址、跳转链接。
- 开关循环播放和自动播放。
- 设置自动播放间隔，范围会被限制在 `1000ms` 到 `60000ms`。
- 上传图片，单张最大 `8MB`。
- 删除当前域已上传的轮播图片。
- 实时预览当前配置。

## 轮播配置格式

管理页会自动生成 JSON，也可以直接编辑 JSON：

```json
[
  {
    "title": "暑期集训报名",
    "img": "/domain/swiper/file/banner.png",
    "url": "/d/default/training"
  },
  {
    "title": "本周比赛",
    "img": "https://example.com/banner.webp",
    "url": "/contest"
  }
]
```

字段说明：

- `title`：鼠标悬停或预览中展示的标题，最长保留 80 个字符。
- `img`：图片地址，不能为空。
- `url`：点击轮播图后的跳转地址，可为空。

安全限制：

- `img` 和 `url` 只允许站内路径或 `http://`、`https://` 地址。
- 会拒绝包含控制字符或 `javascript:`、`data:`、`vbscript:` 协议的地址。
- 图片文件名会被规范化，只允许 `jpg`、`jpeg`、`png`、`gif`、`webp`、`bmp`。

## 安装

```bash
hydrooj addon add /path/to/swiper-for-hydrooj-main
```

安装后重启 Hydro，再到系统设置中加入首页配置，并在 `/domain/swiper` 中配置当前域轮播。

## 注意

- 轮播配置按域隔离，不同域需要分别配置。
- 首页展示依赖 `templates/partials/homepage/swiper.html`。如果其他插件覆盖了同名模板，最终显示取决于加载顺序。
- 插件自带 Swiper 静态文件，前端展示不依赖外部 CDN。
- 如果图片使用外部地址，请确保浏览器能够访问该地址，且站点 CSP 不会拦截。
