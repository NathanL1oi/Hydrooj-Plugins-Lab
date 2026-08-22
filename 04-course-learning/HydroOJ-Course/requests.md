# HydroOJ-Course 实现要求
## 指引
对于变量命名规则请看 hydro-dev/hydro:/packages/hydrooj/src/interface.ts  
对于数据库结构请看 hydro-dev/hydro-dev.github.io:/content/docs/Hydro/dev/db-layout.md  
对于权限结构请看 hydro-dev/hydro:/packages/common/permission.ts

插件需要使用 TypeScript 编写，对于编写的向导请看 hydro-dev/hydro-dev.github.io:/content/docs/Hydro/dev/typescript.md  
以及 Hook：hydro-dev/hydro-dev.github.io:/content/docs/Hydro/dev/hook.md

总之，如果你需要看后端的基本实现，请查阅 hydro-dev/hydro，一些文档可以看 hydro-dev/hydro-dev.github.io
## 要求
适用于 HydroOJ v5 beta-16（即最新版HydroOJ）
### 权限
- 拥有 PERM_VIEW_HOMEWORK 的用户可以查看课程
- 拥有 PERM_CREATE_HOMEWORK 的用户可以创建课程
- 拥有 PERM_ATTEND_HOMEWORK 的用户可以参加课程
- 拥有 PERM_EDIT_HOMEWORK 的用户可以编辑课程
- 还有更多的请看权限结构中的 Homework 部分，保持一致
### 功能
支持新建课程 / 上传讲义（文件） / 多个班级 / 多个教师 / 不同学生不同进度 / 按班级管理

对于进入了当前课程的主界面，将会看到创建者预先写好的介绍、讲义、文件，左侧栏显示已经加入课程的用户，右侧栏有题目列表、成绩表

你可以理解为适用于普通上课使用的增强比赛+训练+作业（有关这些的源代码可以在 hydro-dev/hydro 找到）

可以在顶栏中直接找到课程的入口，位于训练之后，比赛之前

对于界面使用 HydroOJ 的默认 UI
