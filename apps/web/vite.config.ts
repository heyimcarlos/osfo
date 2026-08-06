import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/v1": process.env.OSFO_WEB_PROXY_ORIGIN ?? "http://127.0.0.1:3000",
    },
  },
});
