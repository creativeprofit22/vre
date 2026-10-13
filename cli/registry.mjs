// Only the CLI knows stage order. Stages never import each other.
export const STAGES = ['01-installer', '02-asar', '03-js', '04-native', '05-report', '06-mod'];

export function loadStage(name) {
  if (!STAGES.includes(name)) throw new Error(`unknown stage "${name}"; expected one of: ${STAGES.join(', ')}`);
  return import(new URL(`../stages/${name}/index.mjs`, import.meta.url));
}
