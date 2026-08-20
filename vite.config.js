import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  cacheDir: ".vite-cache",
  server: {
    port: 4181,
    strictPort: true,
    proxy: { "/api": "http://localhost:4180" },
  },
});
