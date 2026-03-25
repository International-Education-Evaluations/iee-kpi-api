/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50:'#e8f7fd', 100:'#b8e8f8', 200:'#88d9f3', 300:'#58caee', 400:'#28bbe9', 500:'#00aeef', 600:'#008bbf', 700:'#00688f', 800:'#004660', 900:'#002330' },
        ocean: { 50:'#f0f7fc', 100:'#dcedf8', 200:'#b9dbf1', 300:'#8cc4e7', 400:'#5faddd', 500:'#3996d3', 600:'#1F4E79', 700:'#1a4268', 800:'#153557', 900:'#0f2946' },
        plum: { 400:'#AB47BC', 500:'#7B1FA2', 600:'#6A1B9A' },
        surface: { 0:'#ffffff', 50:'#f8fafc', 100:'#f1f5f9', 200:'#e2e8f0', 300:'#cbd5e1' },
        ink: { 900:'#0f172a', 800:'#1e293b', 700:'#334155', 600:'#475569', 500:'#64748b', 400:'#94a3b8' }
      },
      fontFamily: {
        display: ['"Plus Jakarta Sans"','system-ui','sans-serif'],
        body: ['"DM Sans"','system-ui','sans-serif'],
        mono: ['"JetBrains Mono"','monospace']
      },
      boxShadow: {
        'card': '0 1px 3px rgba(0,0,0,0.04), 0 1px 2px rgba(0,0,0,0.06)',
        'card-hover': '0 4px 12px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04)',
        'panel': '0 2px 8px rgba(0,0,0,0.04)',
        'nav': '1px 0 0 0 #e2e8f0',
      },
      borderRadius: { 'xl': '12px', '2xl': '16px' }
    }
  },
  plugins: []
};
