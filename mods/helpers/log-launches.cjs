// Sample helper mod: log every process launch made through node:child_process, in the main process
// and in Voyager's backend server. Bundled binaries (the Rust helpers, ffmpeg, api-models, ...) are
// tagged with their name. Output goes to out/06-mod/home/vre-mods.log.
//
// A helper mod can also change the launch before it happens, for example:
//   if (call.helper === 'voyager-resource-monitor') call.args.push('--verbose');           // rewrite args
//   call.options.env = { ...(call.options.env || process.env), RUST_LOG: 'debug' };          // rewrite env
//   if (call.helper === 'ffmpeg') call.file = 'C:\\tools\\ffmpeg.exe';                      // replacement binary
//   call.options.stdio = 'inherit';                                                          // rewrite stdio
module.exports = function logLaunches(call, { log }) {
  const what = call.helper ? `helper ${call.helper}` : 'process';
  const args = call.args.length ? ` ${call.args.map((a) => (String(a).length > 80 ? `${String(a).slice(0, 77)}...` : a)).join(' ')}` : '';
  log(`launch [${call.proc}] ${call.api} ${what}: ${call.file}${args}`);
};
