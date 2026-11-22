import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type Plugin, defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(here, "../bench/results");
const DEPLOYMENTS = resolve(here, "../deployments");

/** bench/results 和 deployments 在 web/ 之外，Vite 默认不监听；新 CSV / 新部署出现时让 glob 重新求值并刷新页面 */
function watchOutside(): Plugin {
  return {
    name: "watch-outside-root",
    configureServer(server) {
      server.watcher.add([RESULTS, DEPLOYMENTS]);
      const onChange = (file: string) => {
        const hit = (file.startsWith(RESULTS) && file.endsWith(".csv")) || (file.startsWith(DEPLOYMENTS) && file.endsWith(".json"));
        if (!hit) return;
        for (const f of ["src/experiments.ts", "src/config.ts"])
          server.moduleGraph.getModulesByFile(resolve(here, f))?.forEach((m) => server.moduleGraph.invalidateModule(m));
        server.ws.send({ type: "full-reload" });
      };
      server.watcher.on("add", onChange);
      server.watcher.on("change", onChange);
    },
  };
}

export default defineConfig({
  plugins: [react(), watchOutside()],
  // 部署地址（../deployments）和实验 CSV（../bench/results）在 web/ 之外，开发服务器需要放行
  server: { port: 5174, fs: { allow: [".."] } },
  base: "./",
  build: { chunkSizeWarningLimit: 700 }, // viem 占大头，纯静态看板不做拆包
});
