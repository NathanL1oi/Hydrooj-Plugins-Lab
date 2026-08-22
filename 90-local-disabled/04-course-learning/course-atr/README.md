由 BPJudge 提供支持。

hydrooj-article / hydrooj-course。

小节编辑页支持题库式批量选题：关键词会同时匹配题号、标题和题目标记，例如输入 `trie` 可检索 `#Trie001. 字典树入门`，也可以按标记和难度筛选后批量加入小节题号。

## 部署注意

上传到服务器时只上传插件源码，不要上传本目录下的 `node_modules`，尤其不要带 `node_modules/hydrooj`。Hydro 运行时会提供自己的 `hydrooj` 模块；如果插件目录里存在不完整的 `node_modules/hydrooj`，会优先加载这个本地包，导致 `Addon load fail`。

服务器上建议清理后重装插件依赖：

```bash
cd /home/hydro-plugins/course-atr
rm -rf node_modules
yarn install --production --ignore-scripts
hydrooj addon add /home/hydro-plugins/course-atr
pm2 restart hydrooj
```

如果你的 Hydro 不是 pm2 管理，最后一步改用实际的重启方式，例如 `systemctl restart hydrooj`。
