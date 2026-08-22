import {
  Context, DocumentModel, Handler, Logger, PERM, Schema, Types, UserModel, param,
} from 'hydrooj';

export const name = 'discussion-search';

export const Config = Schema.object({
  pageSize: Schema.number().min(5).max(100).default(30).description('Results per page'),
  maxPage: Schema.number().min(1).max(1000).default(50).description('Maximum searchable page'),
  minQueryLength: Schema.number().min(1).max(10).default(2).description('Minimum query length'),
  maxQueryLength: Schema.number().min(5).max(100).default(40).description('Maximum query length'),
  maxTimeMs: Schema.number().min(100).max(10000).default(1500).description('Mongo query timeout'),
  allowContentSearch: Schema.boolean().default(false).description('Allow content contains search; may be slower'),
}).description('Discussion title search');

type PluginConfig = ReturnType<typeof Config>;
type AnyDoc = Record<string, any>;

const logger = new Logger('discussion-search');
let pluginConfig: PluginConfig;

const TYPE_PROBLEM = (DocumentModel as any).TYPE_PROBLEM ?? 10;
const TYPE_DISCUSSION_NODE = (DocumentModel as any).TYPE_DISCUSSION_NODE ?? 20;
const TYPE_DISCUSSION = (DocumentModel as any).TYPE_DISCUSSION ?? 21;
const TYPE_CONTEST = (DocumentModel as any).TYPE_CONTEST ?? 30;
const TYPE_TRAINING = (DocumentModel as any).TYPE_TRAINING ?? 40;

const typeMapper: Record<string, number> = {
  problem: TYPE_PROBLEM,
  node: TYPE_DISCUSSION_NODE,
  contest: TYPE_CONTEST,
  homework: TYPE_CONTEST,
  training: TYPE_TRAINING,
};

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanQuery(value: string, maxLength: number) {
  return (value || '').trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function parseParentId(value: string) {
  const asNumber = Number.parseInt(value, 10);
  if (Number.isSafeInteger(asNumber) && `${asNumber}` === value) return asNumber;
  return value;
}

function parentIdQuery(value: string) {
  const parsed = parseParentId(value);
  return parsed === value ? value : { $in: [value, parsed] };
}

function makeSearchUrl(params: Record<string, any>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    query.set(key, String(value));
  }
  return `/discussion-search?${query.toString()}`;
}

function makeSnippet(content: string, keyword: string, size = 140) {
  const text = (content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_\-~|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const lower = text.toLowerCase();
  const needle = keyword.toLowerCase();
  const index = lower.indexOf(needle);
  const start = index > 30 ? Math.max(0, index - 50) : 0;
  const snippet = text.slice(start, start + size);
  return `${start ? '...' : ''}${snippet}${start + size < text.length ? '...' : ''}`;
}

class DiscussionSearchHandler extends Handler {
  @param('q', Types.String, true)
  @param('node', Types.String, true)
  @param('type', Types.String, true)
  @param('page', Types.PositiveInt, true)
  @param('content', Types.Boolean, true)
  async get(domainId: string, q = '', node = '', type = '', page = 1, content = false) {
    const startedAt = Date.now();
    const keyword = cleanQuery(q, pluginConfig.maxQueryLength);
    const nodeName = cleanQuery(node, 100);
    const nodeType = typeMapper[type] ? type : '';
    const pageSize = pluginConfig.pageSize;
    const safePage = Math.min(Math.max(page || 1, 1), pluginConfig.maxPage);
    const searchContent = Boolean(content && pluginConfig.allowContentSearch);
    const nodes = await DocumentModel.getMulti(
      domainId,
      TYPE_DISCUSSION_NODE,
      {},
      ['docId', 'content'] as any,
    ).sort({ content: 1, docId: 1 }).toArray();

    const response: AnyDoc = {
      q: keyword,
      node: nodeName,
      type: nodeType,
      page: safePage,
      pageSize,
      maxPage: pluginConfig.maxPage,
      searchContent,
      allowContentSearch: pluginConfig.allowContentSearch,
      minQueryLength: pluginConfig.minQueryLength,
      results: [],
      nodes,
      hasMore: false,
      elapsedMs: 0,
      prevUrl: '',
      nextUrl: '',
    };

    if (!keyword) {
      this.response.template = 'discussion_search.html';
      this.response.body = response;
      return;
    }

    if (keyword.length < pluginConfig.minQueryLength) {
      response.error = `关键词至少需要 ${pluginConfig.minQueryLength} 个字符`;
      this.response.template = 'discussion_search.html';
      this.response.body = response;
      return;
    }

    const regex = new RegExp(escapeRegExp(keyword), 'i');
    const query: AnyDoc = {};
    if (!this.user.hasPerm(PERM.PERM_EDIT_DISCUSSION)) query.hidden = { $ne: true };
    if (nodeName) {
      query.parentType = typeMapper[nodeType] || TYPE_DISCUSSION_NODE;
      query.parentId = parentIdQuery(nodeName);
    }
    if (searchContent) query.$or = [{ title: regex }, { content: regex }];
    else query.title = regex;

    const projection = [
      '_id', 'docId', 'owner', 'parentType', 'parentId', 'title',
      'nReply', 'views', 'pin', 'updateAt', 'hidden',
      ...(searchContent ? ['content'] : []),
    ] as any;

    try {
      const cursor = DocumentModel.getMulti(domainId, TYPE_DISCUSSION, query, projection)
        .sort({ pin: -1, docId: -1 })
        .skip((safePage - 1) * pageSize)
        .limit(pageSize + 1)
        .maxTimeMS(pluginConfig.maxTimeMs);
      const docs = await cursor.toArray();
      response.hasMore = docs.length > pageSize;
      const results = docs.slice(0, pageSize);
      const udict = await UserModel.getList(domainId, results.map((doc) => doc.owner));
      response.results = results.map((doc) => ({
        ...doc,
        snippet: searchContent ? makeSnippet(doc.content, keyword) : '',
      }));
      response.udict = udict;
    } catch (error) {
      const message = error instanceof Error ? (error.stack || error.message) : String(error);
      logger.warn('%s', message);
      response.error = '搜索超时或失败，请缩短关键词或限定节点后重试';
    }

    response.elapsedMs = Date.now() - startedAt;
    response.prevUrl = makeSearchUrl({
      q: keyword,
      type: nodeType,
      node: nodeName,
      content: searchContent,
      page: safePage - 1,
    });
    response.nextUrl = makeSearchUrl({
      q: keyword,
      type: nodeType,
      node: nodeName,
      content: searchContent,
      page: safePage + 1,
    });
    this.response.template = 'discussion_search.html';
    this.response.body = response;
  }
}

export async function apply(ctx: Context, config: PluginConfig) {
  pluginConfig = config;
  ctx.Route('discussion_search', '/discussion-search', DiscussionSearchHandler, PERM.PERM_VIEW_DISCUSSION);
}
