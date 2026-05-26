"use client";

interface Props {
  data: number[];
  w?: number;
  h?: number;
  stroke?: string;
  fill?: string;
  dashed?: boolean;
}

export function Sparkline({ data, w = 64, h = 22, stroke, fill, dashed }: Props) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i): [number, number] => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / span) * (h - 2) - 1;
    return [x, y];
  });
  const d = pts
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ");
  const last = pts[pts.length - 1]!;
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      {fill && (
        <path d={`${d} L${w},${h} L0,${h} Z`} fill={fill} opacity={0.6} />
      )}
      <path
        d={d}
        fill="none"
        stroke={stroke || "var(--text-3)"}
        strokeWidth="1.25"
        strokeLinejoin="round"
        strokeDasharray={dashed ? "2 2" : undefined}
      />
      <circle cx={last[0]} cy={last[1]} r="1.6" fill={stroke || "var(--text-3)"} />
    </svg>
  );
}
