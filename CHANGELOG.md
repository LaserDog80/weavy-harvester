# Changelog

## 0.1.0 - 2026-10-14

- Standalone MV3 extension for app.weavy.ai, with no build or dependencies.
- Retain the Zustand / React Flow fiber walk, MAIN-world injection, and manual retry.
- Export raw and normalized nodes and edges, prompts, models, full parameters,
  available seeds and timestamps, and deeply discovered media URLs.
- Package board JSON, per-node CSV and optional media in a single STORE-mode ZIP.
- Record per-asset download results, file paths, sizes and SHA-256 hashes.
- Limit media fetches to HTTPS media.weavy.ai; record blocked and failed URLs.
- Carry the ZIP helper and store walk from the author's earlier extension.
- Add dependency-free extraction, archive and popup checks; Chrome validation remains manual.
