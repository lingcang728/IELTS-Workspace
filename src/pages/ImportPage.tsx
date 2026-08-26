import { PageHeading } from "../components/Shell";

export function ImportPage({ value, onChange, onImport }: { value: string; onChange: (s: string) => void; onImport: () => void }) {
  return <div className="page-stack"><PageHeading title="导入试卷" subtitle="导入 Schema v1 JSON。体积 ≤ 2 MB、最多 80 题；资源路径必须是相对路径。已有 ID 不会被覆盖。" /><section className="workspace-card import-card"><textarea rows={18} value={value} onChange={(e) => onChange(e.target.value)} placeholder="在这里粘贴 Schema v1 Exam JSON…" /><button type="button" className="primary-button" onClick={onImport}>确认导入</button></section></div>;
}
