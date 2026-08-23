# hydrooj-countdown

首页倒计时挂件。插件会为 Hydro 首页提供 `countdown` 区块，自动筛选未来日期，并在侧栏中显示当天公历日期、星期和若干个倒计时事件。

本插件是仓库中保留的唯一首页倒计时实现，已替代旧版 `countdown-33oj`。不要同时安装其他也覆盖 `partials/homepage/countdown.html` 或 `HomeHandler.prototype.getCountdown` 的倒计时插件。

## 功能

- 为 `HomeHandler` 增加 `getCountdown()`，首页配置中写入 `countdown` 后即可渲染。
- 从配置的 `dates` 列表中筛选今天及未来的事件，已经过去的日期不会显示。
- 按 `max_dates` 限制最多显示的事件数量。
- 使用 `moment().startOf('day')` 计算剩余天数，避免当前时间影响日期差。
- 在挂件头部显示当天月份、日期和星期。
- 内置中文月份显示，如 `一月大`、`四月小`；闰年时二月显示为 `二月闰`。
- 页面加载后触发 `countdown-finish` 事件，方便其他首页脚本等待倒计时挂件完成。

## 首页配置

在系统设置的 `hydrooj.homepage` YAML 中加入 `countdown` 区块。Hydro 会读取 `partials/homepage/countdown.html` 并把配置作为 `payload` 传入。

示例：

```yaml
- width: 9
  bulletin: true
  contest: 5
  homework: 10
- width: 3
  countdown:
    max_dates: 3
    dates:
      - name: CSP-J/S 第一轮
        date: 2026-09-20
      - name: CSP-J/S 第二轮
        date: 2026-10-25
      - name: NOIP
        date: 2026-11-22
```

字段说明：

- `dates`：事件数组，每项包含 `name` 和 `date`。
- `date`：建议使用 `YYYY-MM-DD` 格式。
- `max_dates`：最多展示的未来事件数。不填时默认展示全部有效事件。

## 显示效果

挂件会在侧栏显示一个日历样式的日期块，并在下方输出类似内容：

```text
距 CSP-J/S 第一轮 还剩 107 天
```

## 安装

```bash
hydrooj addon add /path/to/countdown
```

安装后重启 Hydro，再调整 `hydrooj.homepage` 配置。

## 从旧版迁移

如果服务器上曾安装旧版 `countdown-33oj`，建议先移除旧 addon，再安装本插件：

```bash
hydrooj addon remove /home/hydro-plugins/countdown-33oj
hydrooj addon add /path/to/countdown
```

旧版配置中的 `title` 和 `test` 字段不再渲染；`dates` 与 `max_dates` 可以继续使用。

## 注意

- 插件会覆盖 `HomeHandler.prototype.getCountdown`。如果同时安装其他也实现 `getCountdown` 的插件，后加载的插件会覆盖先加载的实现。
- 日期解析依赖 `moment`，请尽量使用标准日期字符串。
- `max_dates` 只限制输出数量，不会对事件排序；请在配置中按希望展示的顺序排列。
