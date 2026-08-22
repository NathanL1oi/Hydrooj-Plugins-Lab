# hydrooj-course-package

HydroOJ 课程包插件。它把可复用的课程内容作为独立资源管理，层级为：

- 课程包
- 阶段
- 章
- 节

插件刻意避开现有课程和文章插件的命名空间：

- 路由前缀：`/course-package`
- 路由名：`course_package_*`
- 模型名：`global.Hydro.model.coursePackage`
- 文档类型：`10880`、`10881`

## 功能

- 创建、编辑、删除课程包。
- 为课程包维护版本，每个版本用 YAML/JSON 描述阶段、章、节。
- 支持像课程插件一样逐层创建阶段、章、节。
- 节编辑页使用 Hydro 题目选择自动补全，并提供创建题目的快捷入口。
- 导出课程包版本为 JSON。
- 从导出的 JSON 导入到当前域。
- 复制课程包、阶段、章、节到已有 `hydrooj-course` 课程中。

## 树结构示例

```yaml
stages:
  - title: 第一阶段：基础语法
    content: 阶段说明，可写 Markdown。
    chapters:
      - title: 输入输出与表达式
        content: 章说明。
        lessons:
          - title: A+B Problem
            content: 节说明，可写 Markdown。
            pids: [1000]
          - title: 多组输入
            pids: [1001, 1002]
```

也可以直接粘贴 JSON：

```json
{
  "stages": [
    {
      "title": "第一阶段",
      "chapters": [
        {
          "title": "第一章",
          "lessons": [
            { "title": "第一节", "pids": [1000] }
          ]
        }
      ]
    }
  ]
}
```

## 复制到课程的映射

现有 `hydrooj-course` 的结构是“课程 -> 章节 -> 小节”，因此本插件复制时做如下映射：

- 复制整个课程包：每个“阶段 / 章”生成一个课程章节，节生成章节下的小节。
- 复制阶段：该阶段下每个章生成一个课程章节，节生成小节。
- 复制章：该章生成一个课程章节，节生成小节。
- 复制节：生成一个同名课程章节，并在其中生成一个同名小节。

复制功能依赖已安装的课程插件提供 `global.Hydro.model.course.addSection` 和 `addSubSection`。
