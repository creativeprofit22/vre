# 03-js

Process (e.g. beautify/deobfuscate) the JavaScript from stage 02.

## Inputs
`out/02-asar/` folder and its manifest entry.

## Outputs
`out/03-js/` with processed JS (planned); manifest entry `03-js`.
Status is recorded as `stub` until implemented.

## Limits
Stub: processes nothing yet. Deobfuscation is best-effort and never proves original source.

Boundary: this stage only reads the previous stage's output folder and the manifest. It must not import other stages or `cli/`.
