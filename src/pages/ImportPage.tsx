import { useRef, useState } from "react";
import { PageHeading } from "../components/Shell";

export function ImportPage({
  value,
  onChange,
  onImport,
  busy,
}: {
  value: string;
  onChange: (s: string) => void;
  onImport: () => Promise<void>;
  busy?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  function readFile(file: File) {
    if (!file.name.toLowerCase().endsWith(".json") && file.type !== "application/json") {
      setLocalError("请选择 .json 文件");
      return;
    }
    void file.text().then((text) => {
      onChange(text);
      setLocalError(null);
    });
  }

  async function submit() {
    setLocalError(null);
    try {
      await onImport();
    } catch (err) {
      setLocalError(String(err).replace(/^Error:\s*/i, ""));
    }
  }

  return (
    <div className="page-stack">
      <PageHeading
        title="导入试卷"
        subtitle="导入 Schema v1 JSON。体积不超过 2 MB、最多 80 题；资源路径必须是相对路径。已有 ID 不会被覆盖。"
      />
      <section className="workspace-card import-card">
        <input
          ref={inputRef}
          className="sr-only"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) readFile(file);
            event.target.value = "";
          }}
        />
        <div
          className={`import-drop${over ? " over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            const file = event.dataTransfer.files[0];
            if (file) readFile(file);
          }}
        >
          <strong>选择或拖入 JSON 文件</strong>
          <small>也可以直接把内容粘贴到下方</small>
        </div>
        <textarea
          rows={16}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            if (localError) setLocalError(null);
          }}
          placeholder="在这里粘贴 Schema v1 Exam JSON…"
        />
        {localError && <p className="import-error" role="alert">{localError}</p>}
        <button type="button" className="primary-button" disabled={busy || !value.trim()} onClick={() => void submit()}>
          确认导入
        </button>
      </section>
    </div>
  );
}
