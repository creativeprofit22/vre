
const LIMITS = ["Stub: processes nothing yet. Deobfuscation is best-effort and never proves original source."];

export default {
  name: '03-js',
  async run({ inDir, outDir, input, log }) {
    log('03-js: not implemented (stub)');
    return {
      status: 'stub',
      inputs: [inDir ?? input ?? null].filter(Boolean),
      outputs: [],
      notes: ['not implemented'],
      limits: LIMITS,
    };
  },
};
