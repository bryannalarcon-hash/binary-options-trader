import type { Config } from "tailwindcss";

/**
 * Tailwind config — the caret design system is the source of truth, defined
 * as CSS variables in globals.css. These aliases let utility classes like
 * `bg-bg`, `text-text`, `border-line` resolve to the CSS variables so we
 * can mix Tailwind utility classes with the caret kit without duplicating
 * values.
 */
const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Background scale
        bg: "var(--bg)",
        surface: "var(--bg-elev)",
        "bg-elev": "var(--bg-elev)",
        "bg-elev-2": "var(--bg-elev-2)",
        "bg-hover": "var(--bg-hover)",

        // Line scale
        border: "var(--line)",
        line: "var(--line)",
        "line-soft": "var(--line-soft)",
        "line-strong": "var(--line-strong)",

        // Text scale
        text: "var(--text)",
        "text-2": "var(--text-2)",
        "text-3": "var(--text-3)",
        "text-4": "var(--text-4)",

        // Accent
        accent: "var(--accent)",
        "accent-2": "var(--accent-2)",
        "accent-soft": "var(--accent-soft)",
        "accent-line": "var(--accent-line)",
        "accent-ink": "var(--accent-ink)",

        // Semantic up/down (legacy yes/no aliases for back-compat)
        up: "var(--up)",
        down: "var(--down)",
        yes: "var(--up)",
        no: "var(--down)",
        "up-soft": "var(--up-soft)",
        "down-soft": "var(--down-soft)",
        "up-line": "var(--up-line)",
        "down-line": "var(--down-line)",
        warn: "var(--warn)",
      },
      fontFamily: {
        sans: ["Geist", "system-ui", "-apple-system", "sans-serif"],
        mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        "sm-r": "var(--r-sm)",
        "r": "var(--r)",
        "lg-r": "var(--r-lg)",
        "xl-r": "var(--r-xl)",
      },
    },
  },
  plugins: [],
};

export default config;
