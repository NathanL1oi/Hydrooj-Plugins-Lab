# Scratchpad Editor Theme

Hydro 的在线编程模式使用 Scratchpad Monaco Editor。当前 Hydro 源码里这块默认写死了 `vs-light`，所以站点切到暗色模式后，在线编程区域里的代码编辑器仍然会是白色。

这个插件会在在线编程模式打开后同步 Monaco 主题：

- Hydro 暗色模式：`vs-dark`
- Hydro 亮色模式：`vs-light`
- 如果用户已经在 Monaco 里手动选择过自定义主题，则保留用户选择

插件只影响在线编程模式，不修改 Hydro 本体。

## 安装

```bash
hydrooj addon add .\community\scratchpad-editor-theme
```

安装或更新插件后重启 Hydro。

## Hydro 本体里的根因

`packages/ui-default/components/scratchpad/ScratchpadEditorContainer.tsx` 里当前是：

```ts
theme: 'vs-light',
```

如果要在 Hydro 本体修，应该改成类似：

```ts
theme: `vs-${getTheme()}`,
```
