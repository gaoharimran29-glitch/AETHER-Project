module.exports = {
  content: ["./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        mono: ["'JetBrains Mono'", "'Courier New'", "monospace"],
        hud:  ["'Orbitron'", "sans-serif"],
        ui:   ["'Inter'", "sans-serif"],
      },
      colors: {
        'aether': {
          blue:   '#4d94ff',
          cyan:   '#22d3ee',
          green:  '#34d399',
          yellow: '#fbbf24',
          orange: '#fb923c',
          red:    '#f87171',
          purple: '#a78bfa',
        },
      },
    },
  },
  plugins: [],
}