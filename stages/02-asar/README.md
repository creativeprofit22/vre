# 02-asar

Extract the Electron `app.asar` found by stage 01.

## Inputs
`out/01-installer/` folder and its manifest entry.

## Outputs
`out/02-asar/` with the unpacked app tree (planned); manifest entry `02-asar`.
Status is recorded as `stub` until implemented.

## Limits
Stub: extracts nothing yet. Native/unpacked modules outside the asar are not covered.

Boundary: this stage only reads the previous stage's output folder and the manifest. It must not import other stages or `cli/`.
