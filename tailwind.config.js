/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './pages/**/*.html',
    './scripts/**/*.js',
  ],
  theme: {
    extend: {
      fontFamily: {
        'eb-garamond': ['EB Garamond', 'serif'],
      },
      colors: {
        'koda-primary': '#007BFF',
        'koda-secondary': '#6c757d',
        'koda-bg': '#f8f9fa',
      },
    },
  },
  plugins: [],
}
