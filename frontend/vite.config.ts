import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The app reads the contract addresses from the repo's deployment record, never from copies.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@deploy": path.resolve(__dirname, "../deployments") } },
  server: { fs: { allow: [path.resolve(__dirname, "..")] } },
  build: { target: "es2022", sourcemap: false },
});
