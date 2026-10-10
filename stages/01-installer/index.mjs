
const LIMITS = ["Stub: extracts nothing yet. Planned extraction tool and its limits (e.g. unsupported installer formats) to be recorded here."];

export default {
  name: '01-installer',
  async run({ inDir, outDir, input, log }) {
    log('01-installer: not implemented (stub)');
    return {
      status: 'stub',
      inputs: [inDir ?? input ?? null].filter(Boolean),
      outputs: [],
      notes: ['not implemented'],
      limits: LIMITS,
    };
  },
};
