# turtle-display

GOC/Turtle 绘图题支持插件。它会注册一门 `cc.goc` 语言，把 C++ 风格的 GOC 绘图代码接入 Python turtle 运行环境，并在预评测记录中把 EPS 输出转换成 PNG 预览图。

## 功能

- 自动安装或更新 Hydro 语言配置 `cc.goc`。
- 随插件打包 `public/goc.h`，编译前会把该头文件写入评测工作目录。
- `cc.goc` 使用 `g++ -std=c++11 -O2` 编译用户代码。
- 运行时生成 `foo.py`，把用户程序输出的绘图指令拼接到 Python turtle 环境中执行。
- 使用 `xvfb-run -a python3 foo.py` 在无图形界面的评测环境中渲染 turtle。
- turtle 运行结束后输出 EPS。
- 后端监听 `record/judge` 和 `record/change`，发现测试点消息中包含 EPS 时，用 Ghostscript 转换为 PNG。
- PNG 会以 `hydro:<base64>` 的形式写回记录的第二个测试点消息，并广播记录更新。
- 前端在题目详情、比赛题目详情、作业题目详情中注入 `turtle-display` 预览页。
- 前端预览页可以从编辑器读取代码，提供运行、重置、回放、显示/隐藏坐标和 `cin` 输入。
- 当前代码或题目标签包含 `goc`/`turtle` 时，前端会在 scratchpad 中加入绘图预览入口。
- 预评测 AC 且输出包含 EPS 时，前端会弹出 PNG 预览图。

## 运行环境依赖

评测环境需要可用的：

- `python3`
- `g++`
- `xvfb-run`
- `gs`，即 Ghostscript

插件内置了转换保护：

- Ghostscript 转换超时：`4000ms`
- 单张 PNG 最大：`5MB`
- 后端转换缓存：最多 128 张

## 安装语言

插件加载时会尝试自动更新 `hydrooj.langs`，加入：

```yaml
cc.goc:
  display: C++11 GOC Turtle
  code_file: foo.cc
  highlight: cpp
  monaco: cpp
```

也可以通过 Hydro 脚本手动执行插件注册的 `installGocLang`，支持 `dryrun` 检查。若语言列表没有立刻刷新，请重启 Hydro 或评测机。

## 题目配置示例

GOC 绘图题可在 `config.yaml` 中限制语言：

```yaml
type: default
time: 5000ms
checker_type: testlib
checker: checker.py.py3graphics
langs:
  - cc.goc
```

绘图题仍然需要自己的 checker，因为每道题的标准图形和判定逻辑通常不同。

## 前端预览

在题目详情页打开 scratchpad 后，如果代码或题目标签能识别为 GOC/Turtle 内容，插件会加入一个绘图预览页。预览页会把常见的 GOC 调用转换成浏览器 Canvas 绘制命令，用于快速查看效果。

支持的常见操作包括：

- `fd`、`bk`、`rt`、`lt`
- `c`、`size`
- `up`、`down`
- `moveTo`
- `o`、`oo`
- `r`、`rr`
- `e`、`ee`

## 安装

```bash
hydrooj addon add /path/to/turtle-display
```

安装后重启 Hydro。若评测机语言列表没有同步，重新启动 judger。

## 注意

- 插件会修改系统语言配置 `hydrooj.langs`，安装前建议备份现有语言配置。
- `cc.goc` 的运行命令依赖 Linux 评测环境；Windows 环境通常不能直接运行。
- EPS 转 PNG 依赖 Ghostscript，没有 `gs` 时记录不会生成 PNG 预览。
- 前端预览是轻量转换器，适合课堂和调试预览，不等价于完整 C++ 编译执行结果。
- 为降低风险，前端预览会拦截包含 `window`、`document`、`eval`、`cookie` 等关键字的代码。
