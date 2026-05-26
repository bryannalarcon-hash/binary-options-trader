"use client";

/**
 * Caret icon set — 16x16 viewBox, 1.5 stroke, currentColor.
 * Ported from prototype/js/icons.jsx.
 */

import type { CSSProperties, SVGAttributes } from "react";

interface IconProps extends SVGAttributes<SVGSVGElement> {
  size?: number;
}

function makeIcon(
  paths: React.ReactNode,
  strokeWidth = 1.5,
  vb = "0 0 16 16",
): React.FC<IconProps> {
  const Comp: React.FC<IconProps> = ({ size = 14, ...rest }) => (
    <svg
      width={size}
      height={size}
      viewBox={vb}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {paths}
    </svg>
  );
  return Comp;
}

/** The caret brand chevron — used inline in contract titles ("MSFT > $420"). */
export const IconCaret: React.FC<IconProps> = ({ size = 14, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    <path d="M5 3.5 L11 8 L5 12.5" />
  </svg>
);

export const IconArrowUp = makeIcon(<path d="M8 13V3M4 7l4-4 4 4" />);
export const IconArrowDown = makeIcon(<path d="M8 3v10M4 9l4 4 4-4" />);
export const IconClock = makeIcon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3l2 1.5" />
  </>,
);
export const IconExt = makeIcon(
  <>
    <path d="M6 3H3v10h10v-3" />
    <path d="M10 3h3v3" />
    <path d="M7 9l6-6" />
  </>,
);
export const IconSearch = makeIcon(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M13 13l-2.5-2.5" />
  </>,
);
export const IconClose = makeIcon(<path d="M4 4l8 8M12 4l-8 8" />);
export const IconSettings = makeIcon(
  <>
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" />
  </>,
);
export const IconCheck = makeIcon(<path d="M3 8.5l3 3 7-7" />);
export const IconWallet = makeIcon(
  <>
    <rect x="2" y="4" width="12" height="9" rx="1.5" />
    <path d="M11 8h2M2 6h12" />
  </>,
);
export const IconChart = makeIcon(
  <>
    <path d="M2 13h12" />
    <path d="M4 11l3-4 3 2 4-5" />
  </>,
);
export const IconBolt = makeIcon(<path d="M9 1L3 9h4l-1 6 6-8H8z" />);
export const IconRefresh = makeIcon(
  <>
    <path d="M2 8a6 6 0 1 0 1.5-4" />
    <path d="M2 2v3.5h3.5" />
  </>,
);
export const IconCopy = makeIcon(
  <>
    <rect x="5" y="5" width="9" height="9" rx="1.5" />
    <path d="M11 5V3H2v9h2" />
  </>,
);
export const IconInfo = makeIcon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7v4M8 5h.01" />
  </>,
);
export const IconFilter = makeIcon(<path d="M2 3h12L9.5 8.5V13l-3 1V8.5L2 3z" />);
export const IconRight = makeIcon(<path d="M6 3l4 5-4 5" />);
export const IconPyth = makeIcon(
  <>
    <circle cx="8" cy="8" r="6.5" />
    <path d="M8 3v10M4.5 5.5l7 5M4.5 10.5l7-5" />
  </>,
);
export const IconCheckCircle = makeIcon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 8l2 2 3-4" />
  </>,
);
export const IconXCircle = makeIcon(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
  </>,
);
export const IconAlert = makeIcon(
  <>
    <path d="M8 2l6 11H2L8 2z" />
    <path d="M8 7v3M8 12h.01" />
  </>,
);
export const IconSpark: React.FC<IconProps> = ({ size = 12, ...rest }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 12 12"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    {...rest}
  >
    <path d="M1 9 L4 5 L7 7 L11 2" />
  </svg>
);

export const IconDot: React.FC<{ size?: number; style?: CSSProperties }> = ({
  size = 8,
  style,
}) => (
  <span
    style={{
      display: "inline-block",
      width: size,
      height: size,
      borderRadius: 999,
      background: "currentColor",
      ...(style ?? {}),
    }}
  />
);
