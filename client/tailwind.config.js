/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 50:'#f0f4fa',100:'#d9e2f0',200:'#b3c5e1',300:'#8aa5cf',400:'#6085bd',500:'#3d6bab',600:'#1F4E79',700:'#1a4268',800:'#153557',900:'#0f2946' },
        plum: { 400:'#AB47BC',500:'#7B1FA2',600:'#6A1B9A' }
      },
      fontFamily: {
        display: ['"DM Sans"','system-ui','sans-serif'],
        body: ['"IBM Plex Sans"','system-ui','sans-serif'],
        mono: ['"JetBrains Mono"','monospace']
      }
    }
  },
  plugins: []
};
