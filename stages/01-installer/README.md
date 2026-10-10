# 01-installer

Unpack the VY.exe installer.

## Inputs
`--input <path to VY.exe>` (the installer file). No previous stage.

## Outputs
`out/01-installer/` with extracted installer payload (planned); manifest entry `01-installer`.
Status is recorded as `stub` until implemented.

## Limits
Stub: extracts nothing yet. Planned extraction tool and its limits (e.g. unsupported installer formats) to be recorded here.

Boundary: this stage only reads the previous stage's output folder and the manifest. It must not import other stages or `cli/`.
