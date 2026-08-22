# hydro-discussion-search

Hydro discussion title search plugin.

## What It Adds

- A small search form on the discussion list page and discussion node pages.
- `GET /discussion-search?q=keyword`
- Optional node filter: `GET /discussion-search?q=keyword&node=市内赛事`
- Optional scoped node filter: `GET /discussion-search?q=keyword&type=problem&node=1000`
- Optional content search: `GET /discussion-search?q=keyword&content=true`

By default it only searches discussion titles. Title contains search uses a regular expression, so it does not use Mongo text indexes for arbitrary Chinese substrings. The plugin keeps requests bounded by page size, max page, max query length, and Mongo `maxTimeMS`.

## Config

```yaml
discussion-search:
  pageSize: 30
  maxPage: 50
  minQueryLength: 2
  maxQueryLength: 40
  maxTimeMs: 1500
  allowContentSearch: false
```

`allowContentSearch` is disabled by default because searching `content` with substring matching can be expensive on a large discussion table.

## Notes

MongoDB text indexes are token based, not arbitrary substring indexes. For Chinese text, short substring search such as `市内` inside `3 市内赛事` is not reliably accelerated by the built-in text index. Without an extra index field, the practical option is bounded regex search.
