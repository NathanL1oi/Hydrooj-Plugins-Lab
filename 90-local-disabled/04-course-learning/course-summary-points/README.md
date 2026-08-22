# Course Summary Points

HydroOJ course-side summary tasks and domain-scoped learning points.

## What it adds

- A right-side summary card on course section and subsection pages.
- A default summary task is created automatically for each section or subsection when the summary card is opened.
- Teachers can edit the auto-created summary task for a section or subsection.
- Students submit and update their learning summary in the current domain.
- Teachers review submissions and grant points. Point changes are stored as a ledger.
- Teachers can delete a placed summary task and place it again; related submissions and summary points are removed together.
- Domain managers can grant manual, contest, recent-status, or adjustment points.
- Domain managers can delete mistaken non-summary point ledger rows; summary points should be fixed from the review page.
- Domain managers can batch-grant contest rank points; the default top-five rule is `5,4,3,2,1`.
- Domain managers can batch-grant recent activity points by day; the default is one point per active student per day.
- The point table has a standalone rank page, group filters, and CSV export.
- Students with ranking-view permission can open the point table from the top navigation.
- Domain owners and users with domain-management permission are excluded from the student point table.
- Excellent summaries can be displayed and exported.
- Course summary review can be filtered by group for batch review.
- Daily reminder messages are sent once per student per task per day when enabled.
- Student submissions can be sent to an external evaluation-server for AI feedback.

## AI 评测服务

课程小结插件可以对接独立的 AI 评测服务：
[caobao7/evaluation-server](https://github.com/caobao7/evaluation-server)

先部署并启动 evaluation-server，再在 Hydro 里配置下面几个系统设置。配置入口在 Hydro 的系统设置里，搜索 `SummaryEvaluation` 即可找到：

- `SummaryEvaluation.serverUrl`：评测服务地址，例如 `http://127.0.0.1:8000` 或服务器内网地址。
- `SummaryEvaluation.apiKey`：评测服务 API Key，需要和 evaluation-server 里的 bearer token 一致。
- `SummaryEvaluation.timeoutMs`：Hydro 请求评测服务的超时时间，单位毫秒，默认 `8000`。

评分维度由 evaluation-server 端统一内置和维护，Hydro 插件不再提供评分维度 JSON 配置。

如果不方便在 Hydro 系统设置里填，也可以通过 Hydro 进程环境变量配置：

```bash
SUMMARY_EVALUATION_SERVER_URL=http://127.0.0.1:8000
SUMMARY_EVALUATION_API_KEY=hydro_internal_secret
SUMMARY_EVALUATION_TIMEOUT_MS=8000
```

配置完成后，学生每次提交课程小结时，插件会先向 evaluation-server 写入评测任务，再创建一次异步评测。打开学生提交页或教师批改页时会自动拉取一次结果；如果结果还没出，可以点页面上的“刷新 AI 结果”按钮手动获取。

旧提交不会自动创建 AI 评测。教师可以进入“小结批改”页，点击“补评历史小结”，插件会为当前筛选范围内尚未创建 `evaluationId` 的旧提交补交评测任务；已有 AI 评测记录的提交不会重复创建。补评提交后仍可用“刷新 AI 结果”获取完成后的反馈。

## 教师使用流程

1. 打开课程章节或小节页面。
2. 在右侧课程小结卡片里进入“小结任务设置”。
3. 填写普通的小结标题、写作要求、截止时间、最低字数等。
4. 在“AI 评测设置”里填写：
   - `评测题目 ID`：可留空。留空时会自动生成类似 `course-summary:{domainId}:{courseId}:{sectionId}` 的 ID。
   - `参考正文`：学生写小结时依据的原始资料，例如讲义正文、题目背景、课程材料、代码模板等。
   - `参考总结`：教师期望学生总结出的参考答案或标准小结。

5. 学生从课程小结卡片提交自己的小结。
6. 教师打开“小结批改”页查看 AI 分数、总评、优点、不足和内容整改建议。
7. 点“显示修改建议”可以在学生原文旁查看 Markdown 批注稿；点“复制整改稿”可以复制已经应用建议后的正文。

## Compatibility

- The plugin does not modify the existing course or article plugins.
- Routes are under `/course-summary` and `/domain/learning-center`.
- Collections use the `domain.learning.*` prefix and always include `domainId`.

Install with:

```bash
hydrooj addon add /path/to/course-summary-points
```

Restart Hydro after installation.
