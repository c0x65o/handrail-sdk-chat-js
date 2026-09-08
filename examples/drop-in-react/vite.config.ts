import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

function browserModuleGraph(): Plugin {
  return {
    name: "drop-in-react-browser-module-graph",
    generateBundle(_options, bundle) {
      const modules = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        for (const id of Object.keys(output.modules)) modules.add(id);
      }
      this.emitFile({
        type: "asset",
        fileName: "module-graph.json",
        source: `${JSON.stringify([...modules].sort(), null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [browserModuleGraph()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // conversation-state-chat-lab.html is intentionally dev-only and is not
      // emitted by the production example build.
      input: {
        example: fileURLToPath(new URL("./index.html", import.meta.url)),
        chatLab: fileURLToPath(new URL("./chat-lab.html", import.meta.url)),
        reminderLab: fileURLToPath(new URL("./reminder-chat-lab.html", import.meta.url)),
        legacyChatLab: fileURLToPath(new URL("./react-chat-lab.html", import.meta.url)),
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
