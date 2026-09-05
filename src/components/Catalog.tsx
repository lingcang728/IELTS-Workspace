import { Icon } from "./Ui";
import type { CatalogModule } from "../lib/view";

const TAB_LABEL: Record<CatalogModule, string> = {
  all: "全部",
  reading: "阅读",
  listening: "听力",
  writing: "写作",
};

export function CatalogToolbar({ module, setModule, query, setQuery }: { module: CatalogModule; setModule: (m: CatalogModule) => void; query: string; setQuery: (q: string) => void }) {
  return <div className="catalog-toolbar"><div className="filter-tabs">{(["all", "reading", "listening", "writing"] as const).map((m) => <button key={m} type="button" className={module === m ? "active" : ""} onClick={() => setModule(m)}>{TAB_LABEL[m]}</button>)}</div><label className="catalog-search"><Icon name="search" size={16} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索题目" /></label></div>;
}

export function Pagination({ page, pageCount, setPage }: { page: number; pageCount: number; setPage: (p: number) => void }) {
  if (pageCount <= 1) return null;
  return <div className="pagination"><button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {pageCount}</span><button type="button" disabled={page + 1 >= pageCount} onClick={() => setPage(page + 1)}>下一页</button></div>;
}
