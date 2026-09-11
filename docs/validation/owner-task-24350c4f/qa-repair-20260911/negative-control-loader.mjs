import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const sources = JSON.parse(readFileSync(new URL('./baseline-modules.json', import.meta.url)));
const modules = new Map(Object.entries(sources).map(([file, source]) => [pathToFileURL(path.resolve(file)).href, source]));
registerHooks({ load(url, context, nextLoad) {
  if (modules.has(url)) return { format: 'module', source: modules.get(url), shortCircuit: true };
  return nextLoad(url, context);
} });
