/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./lib/**/*.{js,ts,jsx,tsx,mdx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#17201B",
        moss: "#42644B",
        fern: "#6E8F59",
        cloud: "#F5F7F3",
        clay: "#B76E4A",
        line: "#DDE5DA"
      },
      boxShadow: {
        soft: "0 18px 45px rgba(23, 32, 27, 0.08)"
      }
    }
  },
  plugins: []
};
