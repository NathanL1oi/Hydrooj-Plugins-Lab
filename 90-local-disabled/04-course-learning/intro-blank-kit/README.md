# hydrooj-intro-blank-kit

Hydro 程序填空练习插件。教师配置一段带 `[[填空提示]]` 的代码模板；学生端只展示代码填空面板，不展示原题题面。学生填写代码片段后，插件拼成完整代码并交给 Hydro 原生评测。

## 功能

- 教师只配置程序语言和代码填空模板。
- 学生页只显示带语法高亮的代码填空面板。
- `[[填空提示]]` 只作为输入框提示，学生可以填写任意等价代码片段，例如 `a + 1`、`++a`。
- 正确性由原题测试数据判断。

## 模板示例

编辑页只填写代码内容，学生页会显示为：

````md
```cpp
#include <bits/stdc++.h>
using namespace std;

int main() {
    int a;
    cin >> a;
    cout << [[输出表达式]] << endl;
    return 0;
}
```
````

## 安装

```bash
hydrooj addon add "C:\Users\kkkw\Desktop\hydro插件总\02 目前已装\01 20251018\01 安装\intro-blank-kit"
```

安装或更新后重启 Hydro。
