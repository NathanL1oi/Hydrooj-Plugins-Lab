"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
    Handler,
    PRIV,
    ForbiddenError,
    ValidationError,
    db,
} = require("hydrooj");

const collSwitch = db.collection("pluginSwitch");
const MANIFEST_PATH = path.join(__dirname, "plugins.json");

let manifestCache = {
    mtimeMs: -1,
    plugins: [],
    error: null,
};
let disabledPlugins = new Set();

function asArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeId(value) {
    return String(value || "").trim();
}

function normalizePlugin(raw) {
    const id = normalizeId(raw.id || raw.packageName || raw.serverPath);
    if (!id) throw new Error("Plugin id is required.");
    return {
        id,
        title: String(raw.title || id),
        packageName: String(raw.packageName || id),
        category: String(raw.category || "未分类"),
        description: String(raw.description || "暂无功能描述。"),
        serverPath: String(raw.serverPath || raw.packageName || id),
        localPath: raw.localPath ? String(raw.localPath) : "",
        routePatterns: asArray(raw.routePatterns).map(String).filter(Boolean),
        uiNodes: asArray(raw.uiNodes).map(String).filter(Boolean),
        type: String(raw.type || "插件"),
        locked: !!raw.locked,
        note: raw.note ? String(raw.note) : "",
        tags: asArray(raw.tags).map(String).filter(Boolean),
    };
}

function readManifest() {
    try {
        const stat = fs.statSync(MANIFEST_PATH);
        if (stat.mtimeMs === manifestCache.mtimeMs && manifestCache.plugins.length) return manifestCache.plugins;
        const text = fs.readFileSync(MANIFEST_PATH, "utf8").replace(/^\uFEFF/, "");
        const raw = JSON.parse(text);
        const list = Array.isArray(raw) ? raw : raw.plugins;
        if (!Array.isArray(list)) throw new Error("plugins.json must contain an array or a { plugins: [] } object.");
        manifestCache = {
            mtimeMs: stat.mtimeMs,
            plugins: list.map(normalizePlugin),
            error: null,
        };
    } catch (error) {
        manifestCache = {
            ...manifestCache,
            error,
        };
        console.error("[plugin-switch-center] failed to read plugins.json:", error);
    }
    return manifestCache.plugins;
}

function pluginMap() {
    return new Map(readManifest().map((plugin) => [plugin.id, plugin]));
}

async function reloadSwitchState() {
    const plugins = readManifest();
    const ids = plugins.filter((plugin) => !plugin.locked).map((plugin) => plugin.id);
    const docs = await collSwitch.find({ _id: { $in: ids }, disabled: true }).toArray();
    disabledPlugins = new Set(docs.map((doc) => doc._id));
}

function isEnabledSync(id) {
    const plugin = pluginMap().get(id);
    if (plugin?.locked) return true;
    return !disabledPlugins.has(id);
}

async function isEnabled(id) {
    return isEnabledSync(id);
}

function pathCandidates(pathname) {
    const clean = String(pathname || "").split("?")[0] || "/";
    const candidates = [clean];
    const domainMatch = clean.match(/^\/d\/[^/]+(\/.*)?$/);
    if (domainMatch) candidates.push(domainMatch[1] || "/");
    return candidates;
}

function compileRouteMatchers() {
    const matchers = [];
    for (const plugin of readManifest()) {
        if (plugin.locked || !disabledPlugins.has(plugin.id)) continue;
        for (const pattern of plugin.routePatterns) {
            try {
                matchers.push({ plugin, regex: new RegExp(pattern) });
            } catch (error) {
                console.error(`[plugin-switch-center] invalid route pattern for ${plugin.id}: ${pattern}`, error);
            }
        }
    }
    return matchers;
}

function pluginForPath(pathname) {
    const paths = pathCandidates(pathname);
    for (const item of compileRouteMatchers()) {
        if (paths.some((candidate) => item.regex.test(candidate))) return item.plugin;
    }
    return null;
}

function isPluginSwitchPath(pathname) {
    return pathCandidates(pathname).some((candidate) => (
        candidate === "/manage/plugin-switch"
        || candidate === "/manage/plugin-switch-center"
        || candidate === "/plugin-switch"
    ));
}

function uiNodeMap() {
    const map = new Map();
    for (const plugin of readManifest()) for (const name of plugin.uiNodes) map.set(name, plugin.id);
    return map;
}

function allowUiNode(node) {
    const pluginId = uiNodeMap().get(node.name);
    return !pluginId || isEnabledSync(pluginId);
}

function patchUiNodes() {
    const hydro = globalThis.Hydro;
    if (!hydro?.ui?.getNodes) return;
    hydro.ui.__pluginSwitchAllowUiNode = allowUiNode;
    if (!hydro.ui.__pluginSwitchOriginalGetNodes) {
        hydro.ui.__pluginSwitchOriginalGetNodes = hydro.ui.getNodes.bind(hydro.ui);
        hydro.ui.getNodes = (name) => {
            const nodes = hydro.ui.__pluginSwitchOriginalGetNodes(name);
            const allow = hydro.ui.__pluginSwitchAllowUiNode || allowUiNode;
            return nodes.filter((node) => allow(node));
        };
    }
}

function publishModel() {
    const root = globalThis;
    root.Hydro = root.Hydro || {};
    root.Hydro.model = root.Hydro.model || {};
    const model = {
        get plugins() {
            return readManifest();
        },
        get manifestPath() {
            return MANIFEST_PATH;
        },
        reloadManifest: readManifest,
        isEnabled,
        isEnabledSync,
        disabledIds: () => Array.from(disabledPlugins),
    };
    root.Hydro.model.pluginSwitch = model;
}

async function setStatus(id, enabled, actor) {
    const plugin = pluginMap().get(id);
    if (!plugin) throw new ValidationError("pluginId");
    if (plugin.locked) return;
    await collSwitch.updateOne(
        { _id: id },
        {
            $set: {
                _id: id,
                disabled: !enabled,
                updatedAt: new Date(),
                updatedBy: actor,
            },
            $setOnInsert: { createdAt: new Date() },
        },
        { upsert: true },
    );
    if (enabled) disabledPlugins.delete(id);
    else disabledPlugins.add(id);
}

function effectText(plugin) {
    if (plugin.locked) return "核心保护，不允许运行时关闭";
    if (plugin.routePatterns.length && plugin.uiNodes.length) return "隐藏入口并拦截路由";
    if (plugin.routePatterns.length) return "拦截访问路由";
    if (plugin.uiNodes.length) return "隐藏 UI 入口";
    return "状态登记，彻底停用需重启或移除 addon";
}

async function rows() {
    const plugins = readManifest();
    const docs = await collSwitch.find({ _id: { $in: plugins.map((plugin) => plugin.id) } }).toArray();
    const docMap = new Map(docs.map((doc) => [doc._id, doc]));
    return plugins.map((plugin) => {
        const doc = docMap.get(plugin.id) || {};
        const enabled = plugin.locked ? true : !doc.disabled;
        return {
            ...plugin,
            enabled,
            locked: !!plugin.locked,
            effectText: effectText(plugin),
            statusText: plugin.locked ? "核心保护" : enabled ? "已启用" : "已停用",
            statusClass: plugin.locked ? "locked" : enabled ? "on" : "off",
            updatedAt: doc.updatedAt || null,
            updatedBy: doc.updatedBy || 0,
            routeText: plugin.routePatterns.length ? `${plugin.routePatterns.length} 条规则` : "无路由规则",
            uiText: plugin.uiNodes.length ? plugin.uiNodes.join(", ") : "无 UI 节点",
            localText: plugin.localPath || "本地未映射",
        };
    });
}

async function categoryStats(items) {
    const list = items || await rows();
    const map = new Map();
    for (const item of list) {
        const row = map.get(item.category) || {
            name: item.category,
            total: 0,
            enabled: 0,
            disabled: 0,
            locked: 0,
        };
        row.total++;
        if (item.locked) row.locked++;
        else if (item.enabled) row.enabled++;
        else row.disabled++;
        map.set(item.category, row);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function manifestUpdatedAt() {
    try {
        return fs.statSync(MANIFEST_PATH).mtime;
    } catch {
        return null;
    }
}

class PluginSwitchManageHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        if (this.domain?._id !== "system") throw new ForbiddenError("插件主控只允许在 system 主域进入。");
    }

    async get() {
        const items = await rows();
        const switchable = items.filter((item) => !item.locked);
        this.response.template = "plugin_switch_manage.html";
        this.response.body = {
            page_name: "manage_plugin_switch",
            plugins: items,
            categoryStats: await categoryStats(items),
            categories: Array.from(new Set(items.map((item) => item.category))).sort((a, b) => a.localeCompare(b)),
            pluginCount: items.length,
            switchableCount: switchable.length,
            lockedCount: items.filter((item) => item.locked).length,
            enabledCount: switchable.filter((item) => item.enabled).length,
            disabledCount: switchable.filter((item) => !item.enabled).length,
            manifestPath: MANIFEST_PATH,
            manifestUpdatedAt: manifestUpdatedAt(),
            manifestError: manifestCache.error ? String(manifestCache.error.message || manifestCache.error) : "",
        };
    }

    async post() {
        const body = this.request.body || {};
        const raw = body.enabled || [];
        const enabledIds = new Set(asArray(raw).filter(Boolean));
        for (const plugin of readManifest()) {
            if (!plugin.locked) await setStatus(plugin.id, enabledIds.has(plugin.id), this.user._id);
        }
        await reloadSwitchState();
        this.back({ message: "插件开关已保存。" });
    }
}

async function apply(ctx) {
    publishModel();
    patchUiNodes();

    ctx.Route("manage_plugin_switch", "/manage/plugin-switch", PluginSwitchManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route("manage_plugin_switch_center", "/manage/plugin-switch-center", PluginSwitchManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.Route("plugin_switch_shortcut", "/plugin-switch", PluginSwitchManageHandler, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI("ControlPanel", "manage_plugin_switch", { icon: "extension", displayName: "插件主控" }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.injectUI("UserDropdown", "manage_plugin_switch", { icon: "settings", displayName: "插件主控" }, PRIV.PRIV_EDIT_SYSTEM);

    try {
        readManifest();
        await reloadSwitchState();
    } catch (error) {
        console.error("[plugin-switch-center] failed to load switch state, continue with all plugins enabled:", error);
    }

    ctx.on("handler/create/http", async (handler) => {
        patchUiNodes();
        handler.UiContext = handler.UiContext || {};
        handler.UiContext.pluginSwitch = {
            disabled: Array.from(disabledPlugins),
            manifestError: manifestCache.error ? String(manifestCache.error.message || manifestCache.error) : "",
        };
    });

    ctx.on("handler/before", async (handler) => {
        const requestPath = String(handler.request?.path || "");
        if (!requestPath || isPluginSwitchPath(requestPath)) return;
        const plugin = pluginForPath(requestPath);
        if (!plugin) return;
        throw new ForbiddenError(`插件「${plugin.title}」已被超管停用。`);
    });

    ctx.i18n.load("zh", {
        manage_plugin_switch: "插件开关",
        manage_plugin_switch_center: "插件主控",
        plugin_switch_shortcut: "插件主控",
    });
    ctx.i18n.load("en", {
        manage_plugin_switch: "Plugin Switches",
        manage_plugin_switch_center: "Plugin Control",
        plugin_switch_shortcut: "Plugin Control",
    });
}

module.exports = { apply };
