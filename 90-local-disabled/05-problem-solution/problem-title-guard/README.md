# hydrooj-problem-title-guard

题目重名保护插件，用于减少题库维护时的同名题。

## 功能

- 在“创建题目”页面即时检查当前标题是否与当前域题库内已有题目重名。
- 新增“防重名导入”入口，上传 Hydro ZIP 后先预览题名冲突。
- 预览页会列出已有同名题，并给导入题生成可编辑的新题名。
- 后台兜底包装 `ProblemModel.addWithId`，即使走原始创建/导入入口，也会自动给新题追加 `(2)`、`(3)` 等后缀。

## 安装

```powershell
hydrooj addon add "C:\Users\kkkw\Desktop\hydro\04\已装\01\problem-title-guard"
```

安装或更新后重启 Hydro。
