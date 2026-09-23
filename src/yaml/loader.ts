import { loadEsm, YAML_ESM_URL } from "../deps/remote.ts";
import type { YamlModule } from "../types/index.ts";

let yamlModulePromise: Promise<YamlModule> | null = null;

export async function loadYaml(): Promise<YamlModule> {
  if (!yamlModulePromise) yamlModulePromise = loadEsm<YamlModule>(YAML_ESM_URL);
  return await yamlModulePromise;
}
