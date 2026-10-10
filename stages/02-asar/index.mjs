
const LIMITS = ["Stub: extracts nothing yet. Native/unpacked modules outside the asar are not covered."];

export default {
  name: '02-asar',
  async run({ inDir, outDir, input, log }) {
    log('02-asar: not implemented (stub)');
    return {
      status: 'stub',
      inputs: [inDir ?? input ?? null].filter(Boolean),
      outputs: [],
      notes: ['not implemented'],
      limits: LIMITS,
    };
  },
};
