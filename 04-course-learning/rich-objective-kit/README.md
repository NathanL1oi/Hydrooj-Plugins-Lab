# rich-objective-kit

Hydro 富交互客观题插件。它把选择题、填空题和自定义 H5 答题界面挂载在 Hydro 的 `submit_answer` 题型上，学生点击“保存”后会自动生成一次提交，由 `checker.cc` / testlib 判分。

## 设计

- Hydro 底层题型：`submit_answer`
- 插件逻辑题型：富交互客观题
- 插件配置存储：`rich_objective`，并兼容旧版 `problem.richObjective`
- 学生入口：访问 `/p/:pid` 自动跳转到 `/p/:pid/rich-objective`
- 教师配置入口：`/p/:pid/rich-objective/edit`

普通 `submit_answer` 和富交互客观题的区别不靠 Hydro 的 `type` 字段，而靠插件配置表区分。只有插件配置中存在并启用配置的题，才会接管原题详情页。

## 和普通提交答案题的区分

老师在题目页侧栏会看到一个开关：

- `启用富交互题`：为当前 `submit_answer` 题创建默认插件配置，之后访问原题页会直接进入富交互答题页。
- `停用富交互题`：保留 Hydro 的 `submit_answer` 题目和评测文件，但隐藏富交互入口。
- `高级配置`：进入 Markdown 题单 / H5 / CSS 配置页。

所以判断规则是：

```text
Hydro type = submit_answer + 插件开关启用 => 富交互客观题，/p/:pid 自动进入特殊模式
Hydro type = submit_answer + 插件开关未启用 => 普通提交答案题
```

## Hydro 题目配置

在题目的评测设置中使用类似配置：

```yaml
type: submit_answer
checker_type: testlib
checker: checker.cc
subtasks:
  - type: sum
    cases:
      - input: meta.in
        output: meta.ans
        score: 100
```

`meta.in` 和 `meta.ans` 可以是占位文件。真正的判分逻辑通常写在 `checker.cc` 中，读取插件生成的答案文件。

## 提交给 checker 的答案文件

插件提交给 Hydro 的内容不是 JSON，而是 C++ checker 友好的内置答案文件格式。第一行的 `ROK1` 只是版本标记，老师不需要手写它：

```text
ROK1
4
q1 1
B
q2 4
endl
q3 1
A
q3 1
D
```

含义：

- 第一行固定是 `ROK1`。
- 第二行是答案条目数。
- 每个条目先写 `题号 字节长度`，下一段是答案内容。
- 多选题会让同一个题号出现多次。

因为每段答案都带有字节长度，答案里包含空格、换行、中文、引号、冒号、逗号等字符都不会破坏格式。

`examples/checker.cc` 已经提供了默认模板，老师一般只需要改标准答案和分值。

配置页右侧有“补齐 checker 示例”按钮：

- 如果这道题的测试数据里还没有 `checker.cc`，插件会按当前 Markdown 题单生成 `checker.cc`。
- 如果已经有 `checker.cc`，插件不会覆盖它，会生成 `checker.rich-objective.example.cc` 作为参考。
- 插件会补齐 `meta.in`、`meta.ans` 和 `config.yaml` 里缺失的 `type: submit_answer`、`checker_type: testlib`、`checker: checker.cc`、占位 `subtasks`。
- 如果 `config.yaml` 里已经写了自己的 `checker`，插件会保留原值，只把示例 checker 当参考文件放进去。
- Schema 模式下生成的 checker 是“一题一个函数”：例如 `score_1_q1()`、`score_2_q2()`。单选/下拉会生成 `one(answers, "q1")`，多选会生成 `many(answers, "q2")`，多个填空会自动生成 `one(answers, "q3.a")`、`one(answers, "q3.b")`。老师只需要把函数里的 TODO 标准答案和分值逻辑改掉。
- H5 模式或 Markdown 解析失败时，会退回通用 checker 模板。

所以常见流程可以是：先创建普通题，进入 Hydro 评测设置把题型改成提交答案题，回到富交互配置页点击“补齐 checker 示例”，再按题目实际答案修改 checker。

## Markdown 题单模式

教师配置页默认使用 Markdown 题单，不需要手写 JSON。支持：

- `single`：单选
- `multiple`：多选
- `blank`：填空
- `textarea`：长文本
- `select`：下拉选择

配置页会优先把上一次保存的富交互题单放回编辑框；如果还没有保存过富交互题单，或者旧配置只是插件自动生成的示例内容，就会把 Hydro 原题面的 Markdown 放进去当底稿。

配置页允许先保存未完成的 Markdown 草稿；如果还没有写题型标记，页面会提示需要补 `[single:q1]`、`[blank:q1]` 等标记，但不会丢掉编辑框里的内容。

示例：

```markdown
# 课堂小测

选择并填写下面的问题。这里可以写普通 Markdown。

[single:q1] 以下哪一个是二分查找的时间复杂度？
- A. O(n)
- B. O(log n)
- C. O(n log n)

[multiple:q2] 下列哪些排序通常是稳定排序？
- A. 归并排序
- B. 快速排序
- C. 插入排序

[blank:q3] C++ 中输出换行常用的流控制符是？
提示：例如 `endl`

[blank:q4] 内嵌填空
水的化学式是 {{a:第一空}}，氧气的化学式是 {{b:第二空}}。

[blank:q5] 列表填空
- a: 第一空
- b: 第二空

[textarea:q6] 简述二分答案里的单调性。
```

题目头格式是 `[类型:题号] 题干`。如果题目可以不填，写成 `[blank?:q3] 题干`。

单个填空题直接写 `[blank:q1]` 即可。

多个空有两种布局。

内嵌填空写 `{{空id:提示文字}}`，输入框会出现在这段文字所在的位置：

```markdown
[blank:q1] 补全文字
水的化学式是 {{a:第一空}}，氧气的化学式是 {{b:第二空}}。
```

列表填空写在题目下面，输入框会在题干下方按行出现：

```markdown
[blank:q1] 补全下面两个空
- a: 第一空
- b: 第二空
```

两种写法提交给 checker 的答案 key 都是 `q1.a`、`q1.b`。你想让空出现在句子中，就用 `{{a:第一空}}`；想让空作为整理好的答题区，就用 `- a: 第一空`。

选择题选项支持 `- A. 内容` 或 `- [A] 内容`。题号和选项值只使用字母、数字、下划线、点和短横线，可以避免提交给 checker 时出现歧义。

旧版 JSON 配置仍然能读取；如果内容以 `{` 开头，插件会按兼容 JSON 模式解析。

## H5 模式

H5 页面会放在 sandbox iframe 中。页面需要通过 `postMessage` 导出答案：

```html
<script>
function exportAnswers() {
  const answers = {
    q1: document.querySelector('[name=q1]:checked')?.value || '',
    q2: document.querySelector('[name=q2]').value || ''
  };
  window.parent.postMessage({
    type: 'rich-objective:answers',
    answers
  }, '*');
}

window.addEventListener('message', (event) => {
  if (event.data?.type === 'rich-objective:collect') exportAnswers();
});
</script>
```

插件会在学生点击“保存”时请求 H5 导出答案。H5 可以使用任意样式和前端交互，适合特别复杂的页面；普通选择题、填空题直接用 Markdown 题单即可。

H5 导出的 `answers` 可以是普通对象；插件后端会把它转换成内置答案文件格式再提交给 Hydro，checker 不需要解析 JSON。

## 安装

```bash
hydrooj addon add "C:\Users\zacktan\dev\rich-objective-kit"
```

安装或更新后重启 Hydro。

## 注意

- 不要使用 Hydro 原生 `objective`，因为它不能配置 checker。
- 富交互客观题必须基于 `submit_answer`。
- H5 iframe 不授予 `allow-same-origin`，避免页面访问 Hydro 主站上下文。
- 点击“保存”会产生一条真实提交记录，不会在每次改选项时自动提交。
