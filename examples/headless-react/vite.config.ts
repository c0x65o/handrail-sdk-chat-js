import { defineConfig, type Plugin } from "vite";

function browserModuleGraph(): Plugin {
  return {
    name: "headless-react-browser-module-graph",
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
  },
  test: {
    environment: "jsdom",
  },
});
