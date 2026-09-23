import { useEffect, useState } from "react";
import { idbKeys, idbUsageEstimate, type StoreName } from "../idb";
import { formatBytes } from "../lib/importer";

const STORE_LABELS: [StoreName, string][] = [
  ["sessions", "考试会话"],
  ["exams", "导入的试卷"],
  ["transcripts", "听力转录"],
  ["blobs", "音频等资源文件"],
  ["kv", "设置 / 错题 / 生词等"],
];

/**
 * 设置页的存储面板：navigator.storage.estimate() 的用量/配额 +
 * 各 object store 的真实条目数。refreshToken 变化时重新统计。
 */
export default function StorageMeter({ refreshToken = 0 }: { refreshToken?: number }) {
  const [usage, setUsage] = useState<number | null>(null);
  const [quota, setQuota] = useState<number | null>(null);
  const [counts, setCounts] = useState<[string, number][]>([]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [estimate, ...keyLists] = await Promise.all([
        idbUsageEstimate(),
        ...STORE_LABELS.map(([store]) => idbKeys(store)),
      ]);
      if (!alive) return;
      setUsage(estimate.usage ?? null);
      setQuota(estimate.quota ?? null);
      setCounts(STORE_LABELS.map(([, label], i) => [label, keyLists[i].length]));
    })();
    return () => {
      alive = false;
    };
  }, [refreshToken]);

  const ratio = usage != null && quota ? Math.min(1, usage / quota) : null;

  return (
    <div>
      <p className="meta">
        浏览器本地存储：已用 {usage != null ? formatBytes(usage) : "—"}
        {quota != null ? ` / 配额约 ${formatBytes(quota)}` : ""}
      </p>
      {ratio != null && (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          style={{
            marginTop: 8,
            height: 6,
            borderRadius: 3,
            background: "var(--panel-2)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.max(1, Math.round(ratio * 100))}%`,
              height: "100%",
              background: "var(--accent)",
            }}
          />
        </div>
      )}
      <ul className="meta" style={{ margin: "12px 0 0", padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
        {counts.map(([label, n]) => (
          <li key={label} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{label}</span>
            <span>{n} 条</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
