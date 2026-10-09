/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        navy: { 950: "#071120", 900: "#0a1624", 850: "#0f2135", 800: "#142a43", 700: "#1d3756" },
        line: "#213a55",
        ink: "#e2ebf3",
        muted: "#8da2b7",
        signal: "#2cc0d3",
        ok: "#3bc98a",
        warn: "#f0b13c",
        bad: "#ef6458",
        sim: "#a78bfa",
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', '"Segoe UI"', "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
