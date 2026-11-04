/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'monospace'],
      },
      colors: {
        navy: {
          900: '#071527',
          800: '#0B1F3A',
          700: '#102A4C',
          600: '#16355C',
        },
        brand: {
          50: '#EFF6FF',
          100: '#DBEAFE',
          300: '#93C5FD',
          500: '#2563EB',
          600: '#1D4ED8',
          700: '#1E40AF',
        },
        canvas: '#F5F7FA',
        ink: {
          900: '#0F172A',
          600: '#475569',
          400: '#94A3B8',
          200: '#E2E8F0',
        },
        ok: '#16A34A',
        warn: '#F59E0B',
        danger: '#DC2626',
        info: '#0891B2',
      },
      boxShadow: {
        panel: '0 1px 2px rgba(15,23,42,0.06), 0 1px 3px rgba(15,23,42,0.04)',
        drawer: '-12px 0 32px rgba(15,23,42,0.14)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in-right': {
          from: { transform: 'translateX(100%)' },
          to: { transform: 'translateX(0)' },
        },
        'pulse-dot': {
          '0%,100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-in-right': 'slide-in-right 200ms ease-out',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
