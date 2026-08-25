import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Local dev only -- Compose deployment serves web as static files behind its own
      // container, with the API reachable at a separately configured base URL (see
      // src/config.ts). This proxy just avoids CORS friction during `npm run dev`.
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
