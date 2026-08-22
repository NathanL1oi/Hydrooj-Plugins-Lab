# @hydrooj/std-time-calibrator

Hydro 题目评测限制校准插件。插件会在题目的“评测设置”页加入“用标程校准时限和内存”面板，用标程实测每个子任务的运行时间与内存占用，并把结果写回 `config.yaml`。

## 功能

- 在题目“评测设置”页填写标程语言和标程代码。
- 后台提交一条隐藏的校准评测记录，不计入普通提交统计。
- 本次校准评测会临时使用 `5000ms` 时限、`1024m` 内存限制和 `detail: full`，不会先修改原题配置。
- 评测完成后，按每个子任务内最慢测试点计算新时限，按最大内存占用计算新内存限制。
- 若 judge 返回 `Syncing testdata, please wait.`，插件会等待 5 秒后自动重测，最多 5 次。

## 规则

时限：

```text
newTime = max(1000ms, ceil(maxCaseTime * 2 / 500ms) * 500ms)
```

内存：

```text
usedMB = ceil(maxCaseMemoryKB / 1024)
newMemory = ceil(usedMB / 128MB) * 128MB + 128MB
```

例如某子任务最大内存为 `129MB`，向上取到 `256MB` 后额外再给 `128MB`，最终写入 `384m`。

## 使用

1. 打开某道题的“评测设置”页面。
2. 在“用标程校准时限和内存”面板中选择语言。
3. 粘贴标程代码。
4. 点击“运行标程”。
5. 等待评测完成，插件会自动更新原题的 `config.yaml`。

## 注意

- 不支持 `remote_judge`、`objective`、`submit_answer` 类型题目。
- 标程必须 AC，非 AC 不会写回配置。
- 插件按子任务写入 `time` 和 `memory`，并删除测试点级 `case.time` 与 `case.memory`，避免单点限制覆盖子任务限制。
- 如果题目允许较慢或高内存语言，建议后续再手动检查 `time_limit_rate` 和 `memory_limit_rate`。
