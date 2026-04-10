import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const devApiTarget = env.VITE_DEV_API_TARGET || "http://127.0.0.1:3100";

  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@clocktower/domain": path.resolve(__dirname, "../../packages/domain/src/index.ts"),
        "@clocktower/protocol": path.resolve(__dirname, "../../packages/protocol/src/index.ts")
      }
    },
    server: {
      proxy: {
        "/api": {
          target: devApiTarget,
          changeOrigin: true,
          ws: true
        },
        "/content/assets": {
          target: devApiTarget,
          changeOrigin: true
        }
      }
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/testSetup.ts"
    }
  };
});
