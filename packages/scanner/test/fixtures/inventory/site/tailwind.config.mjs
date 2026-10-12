/** Read statically by youi inventory, never executed. */
export default {
  content: ["./src/**/*.{astro,ts,tsx}"],
  theme: {
    extend: {
      borderRadius: { md: "8px" },
      fontSize: { sm: ["14px", { lineHeight: "20px" }] },
    },
  },
};
