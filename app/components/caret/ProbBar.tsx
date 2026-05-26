"use client";

interface Props {
  /** Yes-side probability in 0..100 cents. */
  yes: number;
  h?: number;
  showLabels?: boolean;
}

export function ProbBar({ yes, h = 6, showLabels = false }: Props) {
  const yesClamped = Math.max(0, Math.min(100, yes));
  const no = 100 - yesClamped;
  return (
    <div>
      <div
        style={{
          display: "flex",
          height: h,
          borderRadius: 999,
          overflow: "hidden",
          background: "var(--bg-elev-2)",
        }}
      >
        <div style={{ width: `${yesClamped}%`, background: "var(--up)" }} />
        <div style={{ width: `${no}%`, background: "var(--down)" }} />
      </div>
      {showLabels && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 4,
            fontSize: 11,
            fontFamily: "var(--mono)",
          }}
        >
          <span className="up">{yesClamped}¢ YES</span>
          <span className="dn">{no}¢ NO</span>
        </div>
      )}
    </div>
  );
}
