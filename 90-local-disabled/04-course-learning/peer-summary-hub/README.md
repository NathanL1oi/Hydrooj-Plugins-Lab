# peer-summary-hub

优秀总结互评插件。读取 `course-summary-points` 中被老师标为 excellent 的总结，提供展示、点赞和同伴留言。

## 路由

- `/domain/summary-hub`：优秀总结列表。
- `/domain/summary-hub/:sid`：总结详情、点赞、留言。

## 依赖数据

- `course-summary-points` 的 `domain.learning.summarySubmit` 和 `domain.learning.summaryTask`。
