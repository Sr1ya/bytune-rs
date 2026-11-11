/** @type {import('tailwindcss').Config} */

/*
 * ByTune design tokens — an Apple-Music visual language: pure-black canvas, layered neutral surfaces,
 * glass chrome, and artwork-derived tinting as the only source of colour.
 *
 * Surfaces (deepest → highest), all CSS-variable driven:
 *   base     app background (#000000)
 *   surface  main content background
 *   panel    sidebar / panels / cards
 *   elevated floating menus, toasts, modals
 *
 * Ink (text hierarchy), likewise variable driven:
 *   ink.hi    primary headlines
 *   ink       body / default
 *   ink.dim   secondary text
 *   ink.faint tertiary
 *   ink.ghost disabled / decorative
 *
 * primary / on-primary: the solid monochrome button (dark: white bg + black
 * text; light: near-black bg + white text).
 *
 * accent: pure white in dark theme (primary =
 * white, background = black). The shell is strictly monochrome — artwork-derived
 * tinting is the only colour the app introduces.
 *
 * Radii: rows 8 · cards/artwork 12 · hero 18 · floating panels 20 · modals 24
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        accent: "rgb(var(--accent) / <alpha-value>)",
        base: "rgb(var(--base) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        elevated: "rgb(var(--elevated) / <alpha-value>)",
        primary: "rgb(var(--primary) / <alpha-value>)",
        "on-primary": "rgb(var(--on-primary) / <alpha-value>)",
        ink: {
          hi: "rgb(var(--ink-hi) / <alpha-value>)",
          // Body ink is white @ 92% in dark mode — baked so bare `text-ink`
          // matches the old rgba exactly; triplet still flips with the theme.
          DEFAULT: "rgb(var(--ink) / 0.92)",
          dim: "rgb(var(--ink-dim) / <alpha-value>)",
          // Tertiary / decorative are white @ 55% / 34% — same deal.
          faint: "rgb(var(--ink-faint) / 0.55)",
          ghost: "rgb(var(--ink-ghost) / 0.34)",
        },
      },
      fontFamily: {
        sans: ['"Segoe UI Variable Text"', '"Segoe UI"', "system-ui", "-apple-system", '"Helvetica Neue"', "Arial", "sans-serif"],
        display: ['"Segoe UI Variable Display"', '"Segoe UI Variable Text"', '"Segoe UI"', "system-ui", "sans-serif"],
      },
      boxShadow: {
        /* Base elevation + a floating variant for menus/modals */
        elev: "0 4px 24px rgba(0, 0, 0, 0.45)",
        float: "0 24px 64px -16px rgba(0, 0, 0, 0.75), 0 2px 8px rgba(0, 0, 0, 0.5)",
        glow: "0 8px 24px -6px rgb(var(--accent) / 0.45)",
        /* Apple-Music artwork drop: deep, wide, no colour cast */
        art: "0 24px 60px -16px rgba(0, 0, 0, 0.8)",
        /* Liquid-glass inset highlight (top edge catches the light) */
        glass: "inset 0 0.5px 0 rgba(255, 255, 255, 0.5), 0 4px 24px rgba(0, 0, 0, 0.25)",
        /* Pill chrome: a lighter glass drop for the small rounded surfaces
           in the sidebar and the player bar. */
        pill: "inset 0 0.5px 0 rgba(255, 255, 255, 0.5), 0 4px 18px rgba(0, 0, 0, 0.18)",
      },
      keyframes: {
        "pop-in": {
          from: { opacity: "0", transform: "translateY(10px) scale(0.97)" },
          to: { opacity: "1", transform: "none" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "slide-up": {
          from: { opacity: "0", transform: "translateY(12px)" },
          to: { opacity: "1", transform: "none" },
        },
        /* artwork mesh blobs drift slowly on an 8s loop */
        drift: {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1)" },
          "50%": { transform: "translate3d(0,-4%,0) scale(1.08)" },
        },
        drift2: {
          "0%,100%": { transform: "translate3d(0,0,0) scale(1.05)" },
          "50%": { transform: "translate3d(3%,3%,0) scale(1)" },
        },
        "mesh-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        "pop-in": "pop-in 0.22s cubic-bezier(0.2, 0.8, 0.3, 1)",
        "fade-in": "fade-in 0.2s ease-out",
        /* `backwards`, not `both`: a forwards fill keeps every section on a
           composited transform layer for the life of the page, and the layer
           edges clip the artwork wash into faint horizontal "shadow" seams. */
        "slide-up": "slide-up 0.28s cubic-bezier(0.2, 0.8, 0.3, 1) backwards",
        drift: "drift 8s ease-in-out infinite",
        drift2: "drift2 8s ease-in-out infinite",
        "mesh-in": "mesh-in 0.9s cubic-bezier(0.4, 0, 0.2, 1)",
      },
    },
  },
  plugins: [],
};