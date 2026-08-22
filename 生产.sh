#!/usr/bin/env bash
# 生产.sh — 在服务器上注册当前已启用的 HydroOJ 插件
#
# 用法：
#   bash 生产.sh              依次执行 hydrooj addon add <插件路径>
#   bash 生产.sh --dry-run    只打印将执行的命令，不实际注册
#
# 说明：
#   - 插件清单与顺序来自 installed-addons.clean.json（即线上 addon.json 的
#     原始加载顺序），逐个 addon add 后 addon.json 顺序与线上一致。
#   - 仓库内 90-local-disabled/ 下的插件为归档，不在本脚本范围内。
#   - 首次执行前自动备份 addon.json 到同目录的 addon.json.bak.<时间戳>。
#   - 脚本可重复执行；若 addon.json 中存在指向旧路径的同名条目，请先
#     hydrooj addon rm <包名> 移除，或恢复备份后重来。
#   - 全部注册完成后需要重启 Hydro 生效（如 systemctl restart hydrooj）。

set -euo pipefail

# 仓库根目录（默认取脚本所在位置，克隆到任意路径均可）
BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDON_JSON="${HYDRO_HOME:-/root/.hydro}/addon.json"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=1
fi

# 当前启用的插件（顺序 = 线上 addon.json 原始顺序）
PLUGINS=(
    "04-course-learning/HydroOJ-Course"            # 课程系统（新版 @hydrooj/course，替换旧 hydrooj-course）
    "05-problem-solution/download-first"           # 下载优先
    "01-homepage-frontend/hydro-float-widget"      # 浮窗通知
    "02-account-interaction/badge-33oj"            # 徽章
    "01-homepage-frontend/frontend-33oj"           # 33OJ 前端模板
    "01-homepage-frontend/extension"               # Hydro plus 前端增强
    "03-domain-user-management/users-manage"       # 用户管理
    "02-account-interaction/coin-33oj"             # 金币/商城
    "06-contest-rating/hydro-hide-objective-score" # 隐藏客观题分数
    "06-contest-rating/hydro-live-board"           # 实时榜单
    "07-content-system/hydro-discussion-search"    # 讨论搜索
    "06-contest-rating/contest-bulk-submit"        # 比赛批量提交
    "06-contest-rating/contest-vp-mode"            # CF 风格 VP
    "07-content-system/contest-summary"            # 赛后总结
    "04-course-learning/rich-objective-kit"        # 客观题/填空增强
    "06-contest-rating/contest-flexible-start"     # 灵活开赛
    "03-domain-user-management/domain-user-grade"  # 域用户年级
    "01-homepage-frontend/user-background"         # 用户背景图
    "03-domain-user-management/domain-register-guide" # 域注册引导
    "01-homepage-frontend/scratchpad-editor-theme" # Scratchpad 编辑器主题
    "06-contest-rating/contest-pdf"                # 比赛题面 PDF
    "01-homepage-frontend/problem-difficulty-label" # 洛谷式难度标签（新增，不在 2026-07-12 导出清单中；若线上未启用可先注释掉）
)

echo "==> 仓库目录: ${BASE_DIR}"
echo "==> addon.json: ${ADDON_JSON}"

# 预检查：所有插件目录必须存在，任何一个缺失都直接中止，避免注册一半
missing=0
for p in "${PLUGINS[@]}"; do
    if [[ ! -f "${BASE_DIR}/${p}/package.json" ]]; then
        echo "错误: 插件目录缺失或不完整: ${BASE_DIR}/${p}" >&2
        missing=1
    fi
done
[[ "${missing}" == "1" ]] && exit 1

if [[ "${DRY_RUN}" == "1" ]]; then
    echo "==> dry-run，将执行以下命令："
    for p in "${PLUGINS[@]}"; do
        echo "    hydrooj addon add \"${BASE_DIR}/${p}\""
    done
    exit 0
fi

if ! command -v hydrooj >/dev/null 2>&1; then
    echo "错误: 未找到 hydrooj 命令，请在已安装 HydroOJ 的服务器上运行。" >&2
    exit 1
fi

# 备份现有 addon.json（存在才备份）
if [[ -f "${ADDON_JSON}" ]]; then
    backup="${ADDON_JSON}.bak.$(date +%Y%m%d%H%M%S)"
    cp "${ADDON_JSON}" "${backup}"
    echo "==> 已备份 addon.json -> ${backup}"
fi

for p in "${PLUGINS[@]}"; do
    echo "==> 注册 ${p}"
    hydrooj addon add "${BASE_DIR}/${p}"
done

echo ""
echo "完成：已注册 ${#PLUGINS[@]} 个插件。"
echo "请重启 Hydro 生效（例如: systemctl restart hydrooj），如遇异常可恢复刚才的 addon.json 备份后重启。"
