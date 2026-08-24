import { PageHeading } from "../components/Shell";

export function ImportPage({ value, onChange, onImport }: { value: string; onChange: (s: string) => void; onImport: () => void }) {
  return <div className="page-stack"><PageHeading title="导入试卷" subtitle="导入 Schema v1 JSON，不覆盖已有题库与会话" /><section className="workspace-card import-card"><textarea rows={18} value={value} onChange={(e) => onChange(e.target.value)} placeholder="在这里粘贴 Schema v1 Exam JSON…" /><button type="button" className="primary-button" onClick={onImport}>确认导入</button></section></div>;
}
