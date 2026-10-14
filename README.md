# Weavy Harvester

A standalone Chrome extension that strip mines the open Weavy board for lineage
work. It saves every node and edge exposed by the board's React Flow store,
prompts, models, parameters, available seeds and timestamps, and referenced media
in one ZIP. No npm packages, build step, backend, API key or companion app.

Version: **0.1.0**. Manifest V3. Use a current desktop Chrome release.

## Install: load unpacked

1. Keep this repository in a permanent local folder.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode** at the top right.
4. Click **Load unpacked**.
5. Select the folder where you cloned this repository.
6. Pin **Weavy Harvester** from Chrome's Extensions menu.
7. After changing extension files, click **Reload** on its extension card.

The host permissions are exactly `https://app.weavy.ai/*` and
`https://media.weavy.ai/*`. `scripting` reads the board in the page's MAIN world;
`downloads` saves the ZIP. There is no service worker, content listener,
request interception, telemetry or non-Weavy host permission.

## Usage

1. Sign into Weavy and open the board at `https://app.weavy.ai/...`.
2. Wait for the board to finish loading. Pan or zoom around a large board so any
   lazy-loaded state has a chance to populate. Wait for running generations to finish.
3. Click the **Weavy Harvester** extension icon.
4. Leave **Download media** checked to include referenced media. Uncheck it for
   a metadata-only ZIP containing the same JSON graph and CSV.
5. Click **Harvest board**. The popup reports extraction and media progress.
6. Keep the popup open. Choose the ZIP destination when Chrome asks. Keep the
   popup open until Chrome finishes the download; do not navigate the board mid-harvest.
7. Open Chrome's Downloads panel to confirm completion, then unzip the archive.
8. Inspect `mediaSummary`, each node's `assets`, and `serializationWarnings` in
   the JSON. A ZIP with failures is a partial media archive, not proof of completion.
9. For a failed or incomplete harvest, reload the board, wait, and click
   **Harvest board** again. This creates a fresh archive, not a resume or merge.

The source's manual retry behaviour is retained: controls become usable again
after an error. There is no automatic extraction or HTTP retry. Empty stores and
boards with zero edges are rejected, as in the source extractor.

## ZIP layout

```text
<board>.zip
  <board>.json
  manifest.csv
  media/
    <node-id>_001.png
    <node-id>_002.mp4
    <node-id>_003.png
```

Board titles and node IDs are sanitized to ASCII letters, digits, underscores
and hyphens, at most 100 characters. An empty name becomes `board`. The original
IDs and title remain in JSON. Media numbers follow the per-node URL order;
colliding sanitized names receive an extra suffix. Extensions come from the
response MIME type, then the URL suffix, then `.bin`. Media is saved byte for byte.
A metadata-only archive, or an archive with no successful fetches, has no media entries.

Every distinct referenced URL is fetched once **per node**. Shared assets may
therefore appear under several node IDs. Thumbnails, input references, historical
generation URLs and outputs are all retained when present in the node state.
The board does not reliably label their roles; `outputMediaPaths`, `assetUrls`
and CSV `output_file` are inventories, not assertions that every item was generated
by that node. Edges and the untouched raw data supply the lineage context.

Only HTTPS URLs on **exactly `media.weavy.ai`** are fetched, without cookies.
Signed query strings are preserved. Other discovered media URLs remain in JSON
with a skipped reason. Redirects are refused, even to the same host. HTTP errors,
HTML/JSON responses, empty bodies and 120-second timeouts become explicit failed
asset records; the remaining files still export. Nothing rewrites thumbnail URLs
into guessed originals.

## JSON schema (version 1.0)

This is the field contract. Optional normalized fields are omitted when absent;
missing generation metadata is never invented. The export preserves the parser-
compatible top-level `nodes` and `edges` shape from the original extractor.

| Field | Type / meaning |
| --- | --- |
| `schemaVersion` | String, `1.0` |
| `extractorVersion` | String, `0.1.0` |
| `exportSource` | String, `weavy-harvester` |
| `boardId`, `boardTitle` | Strings; ID from the last URL path component, title from the page title |
| `_sourceUrl` | Original page URL |
| `_extractedAt`, `_archiveStartedAt`, `_archivedAt` | ISO UTC timestamps for this export, not generation times |
| `_stateSource` | Which window/store/fiber route found the state |
| `mediaDownloadRequested` | Boolean corresponding to the checkbox |
| `mediaSummary` | Counts: `referenced`, `downloaded`, `failed`, `skipped`; counts per-node references |
| `serializationWarnings` | Array of strings identifying omitted runtime fields or replaced cycles |
| `nodes` | Array of normalized nodes, each retaining a `raw` snapshot |
| `edges` | Array of normalized edges, each retaining a `raw` snapshot |

| Node field | Type / meaning |
| --- | --- |
| `id`, `type`, `name` | Store ID, node type, and display name |
| `raw` | Original node with all JSON-compatible fields, including `data`, position and metadata |
| `model` | Object; string models normalize to `{ "name": "..." }`; model objects retain their fields |
| `prompt` | String from `data.prompt` or `data.promptText` |
| `params` | All `data.parameters` and `data.params` keys, with `data.params` taking precedence; common top-level duration/resolution/aspect/audio aliases are also normalized |
| `seed` | Available `data.seed`, then merged `params.seed`, then node-level `seed`; zero is preserved |
| `timestamps` | Present `createdAt`, `updatedAt`, `created_at`, `updated_at`, `timestamp` fields; original values and spelling |
| `imagePath` | Source image path, or a discovered thumbnail candidate |
| `outputMediaPaths` | Source output paths merged with discovered media references |
| `assetUrls` | Media-looking HTTP(S) URLs found by recursively walking the entire node |
| `assets` | Array of per-URL download records described below |

`assets[]` always contains `url`, `status` (`downloaded`, `failed`, `skipped`),
and `file` (archive-relative path or `null`). Downloaded records also contain
`sha256` (lowercase hex), `bytes`, `contentType`, `fetchedAt`. Failed records
contain `error`; skipped records contain `reason`.

Each edge contains `id`, `source`, `target`, `sourceHandle`, `targetHandle`,
`sourceHandleType`, and `raw`. The handle type falls back to `data.type`,
`data.handleType`, then `any`. Other edge properties remain in `raw`.

The URL scanner retains media host URLs even without a file suffix. It also
recognizes common image, video and audio suffixes and source CDN patterns. Any
unrecognized field or URL still remains in `raw`. The normalized view covers
known keys; a changed or custom node shape may require reading `raw.data`.

Example, abbreviated to one asset record:

```json
{
  "schemaVersion": "1.0",
  "extractorVersion": "0.1.0",
  "exportSource": "weavy-harvester",
  "boardId": "board-1",
  "boardTitle": "Example board",
  "_sourceUrl": "https://app.weavy.ai/board/board-1",
  "_extractedAt": "2026-10-14T10:00:00.000Z",
  "_archiveStartedAt": "2026-10-14T10:00:00.100Z",
  "_archivedAt": "2026-10-14T10:00:01.000Z",
  "_stateSource": "fiber.memoizedState (zustand)",
  "mediaDownloadRequested": true,
  "mediaSummary": { "referenced": 1, "downloaded": 1, "failed": 0, "skipped": 0 },
  "serializationWarnings": [],
  "nodes": [
    {
      "id": "prompt-1", "type": "promptV3", "name": "Prompt",
      "prompt": "A boat approaches the steps.", "timestamps": {}, "assetUrls": [], "assets": [],
      "raw": { "id": "prompt-1", "type": "promptV3", "data": { "prompt": "A boat approaches the steps." } }
    },
    {
      "id": "gen-1", "type": "custommodelV2", "name": "Generation",
      "model": { "name": "example-model" },
      "params": { "seed": 42, "duration": 5, "steps": 30 },
      "seed": 42,
      "timestamps": { "created_at": "2026-10-13T12:00:00Z" },
      "outputMediaPaths": ["https://media.weavy.ai/video/upload/example.mp4"],
      "assetUrls": ["https://media.weavy.ai/video/upload/example.mp4"],
      "assets": [{
        "url": "https://media.weavy.ai/video/upload/example.mp4",
        "status": "downloaded", "file": "media/gen-1_001.mp4",
        "bytes": 12345, "contentType": "video/mp4",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "fetchedAt": "2026-10-14T10:00:00.900Z"
      }],
      "raw": {
        "id": "gen-1", "type": "custommodelV2",
        "data": {
          "model": "example-model", "params": { "seed": 42, "duration": 5, "steps": 30 },
          "created_at": "2026-10-13T12:00:00Z",
          "outputMediaPaths": ["https://media.weavy.ai/video/upload/example.mp4"]
        }
      }
    }
  ],
  "edges": [{
    "id": "edge-1", "source": "prompt-1", "target": "gen-1",
    "sourceHandle": "", "targetHandle": "prompt", "sourceHandleType": "any",
    "raw": { "id": "edge-1", "source": "prompt-1", "target": "gen-1", "targetHandle": "prompt" }
  }]
}
```

The example URL, model, byte count and digest are illustrative. Prompt-only
nodes commonly feed model nodes through edges; the harvester does not duplicate
upstream prompts into downstream nodes or guess which input is the positive prompt.

## CSV columns

UTF-8, comma-separated, quoted cells, CRLF row separators; one row per node.

| Column | Value |
| --- | --- |
| `id` | Original node ID |
| `type` | Original node type |
| `model` | Model name, ID or serialized object; blank if absent |
| `prompt` | Node-local prompt; blank if absent |
| `inputs` | JSON array of incoming edge source IDs, in edge order |
| `output_file` | JSON array of successfully saved archive-relative media paths; `[]` if none |

Quotes and multiline prompts use standard CSV escaping. Formula-like cells get
a leading apostrophe for spreadsheet safety. Exact original text remains in JSON.
For port-level ancestry or failed/skipped media, use JSON rather than the CSV.

## Known limits

- This is a snapshot of the loaded store, not a server-side board/history API.
  Deleted nodes, unavailable history and data not loaded into that store cannot be recovered.
- Weavy's private React/Zustand store layout can change. The fiber walk searches
  up to 200 ancestors, with window-store and props fallbacks; it may then fail.
- Lazy-rendered boards can expose incomplete state. Pan/zoom and compare the
  exported node/edge counts with the board. A successful extraction cannot certify completeness.
- A zero-edge board is refused, including valid boards made only of disconnected nodes.
- Fields outside known normalized keys remain in `raw`; unavailable prompts,
  models, seeds and generation dates remain unavailable. Export timestamps do not replace them.
- Runtime functions, symbols and undefined object fields are omitted with warnings;
  cycles become `[Circular]`, big integers become decimal strings. Only JSON-compatible
  source data is preserved exactly. This is not a dump of the whole application store.
- Media outside `media.weavy.ai`, redirects, expired links and private/session-only
  media are not downloaded. Reharvest after reloading to obtain refreshed links.
- The popup owns the job. Closing it, switching focus, or navigating can interrupt
  an archive before saving. There is no background resume or persisted job state.
- Media fetches are sequential. The full archive and source blobs occupy memory;
  large boards may exhaust Chrome memory before the format limit. STORE-mode ZIP
  has no compression or ZIP64: fewer than 4 GiB total and at most 65,535 entries.
- No C2PA validation, signed provenance assertion, prompt reconstruction or filesystem
  matching is performed. Hashes identify downloaded bytes only.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Open a board / wrong tab error | Activate the board on exactly `https://app.weavy.ai`, then reopen the popup. |
| Could not locate React Flow state | Wait, reload the board, and retry. Persistent errors may require updating the extractor. |
| Zero nodes or zero edges | Wait for loading, pan/zoom, reload, and retry. Disconnected boards are unsupported. |
| Some media failed | Read `nodes[].assets[].error`; reload and reharvest for expired links. |
| Some media skipped | Check the checkbox and each `reason`; non-permitted hosts require a separate downloader. |
| No ZIP after closing the popup | Leave it open and harvest again. Check Chrome Downloads for cancellation or failure. |
| Huge board freezes or ZIP limit error | Export metadata-only and use the recorded URLs in a separate bulk downloader. |
| Extension errors | Open `chrome://extensions`, inspect the extension's Errors and popup console, then reload the extension. |

## Verification and required human tests

**The extension cannot be loaded in Chrome in this environment. No live Chrome
extension or Weavy CDN test has been performed.** Node mocks do not establish
that the current live Weavy store still has this layout.

Dependency-free checks, using Node 22.15+ (for the test reader's CRC32 API):

```sh
node --test tests/verify.mjs
```

Verified offline on 2026-10-14 with Node 26.11.1: all 12 checks passed, including
the mounted reference board (163 nodes, 141 edges, 864 mocked media fetches).
No reference-board content is committed to this repository.

These cover all four store-discovery routes, metadata/raw preservation, cycles,
manual retry, ZIP directory offsets and CRCs, media bytes/hashes and failure
records, CSV escaping, host restrictions, ZIP limits, and mocked popup wiring.
The mounted reference export can also be checked without making network requests:

```sh
WEAVY_REFERENCE='/path/to/your_board_export.json' node --test tests/verify.mjs
```

Before relying on this extension, a human must run all of these Chrome checks:

1. Load unpacked. Confirm no manifest/CSP errors and only the two Weavy host grants.
2. On a fully loaded connected board with known prompts, seeds and custom params,
   harvest with media checked. Confirm MAIN-world extraction works; compare every
   node/edge count and a known model, prompt, parameter, seed and timestamp with the board.
3. Finish Chrome's save dialog while keeping the popup open. Confirm Downloads
   completes; unzip with a normal ZIP reader, open images/videos/audio, and compare
   a media SHA-256 with JSON. Check JSON/CSV links resolve to the right node files.
4. Include a multi-output/history node, an extensionless URL, a thumbnail, a shared
   asset and a long multiline prompt. Confirm all visible stored URLs are accounted
   for, every node has one CSV row, and quoting survives spreadsheet import.
5. Harvest with media unchecked. Confirm one ZIP containing only board JSON/CSV,
   no media fetches, and explicit skipped records.
6. Try a wrong tab, a board still loading, and a zero-edge board. Confirm useful
   errors, then reload a valid board and retry without reloading the extension.
7. Exercise an expired/unavailable media URL and an off-host reference. Confirm
   failed/skipped records and a usable partial ZIP, with a warning for failures.
8. On a large/lazy-loaded board, pan/zoom fully, compare counts, complete a media
   archive and watch memory. Close the popup mid-job, then reopen and confirm a
   fresh retry works; do not expect resume.

## Where it fits

Weavy Harvester is the collection stage for lineage and provenance tooling.
Feed the board JSON to a compatible graph parser, use `edges` to follow upstream
prompts and inputs, and use `assets[].file` plus `sha256` to associate downloaded
media with generation nodes. A lineage tool can then match delivered shots to
those bytes or their derivatives. Existing tools may require unzipping and
importing the JSON separately; their ZIP import support has not been verified.

## Files and licence

- `manifest.json`: MV3 permissions and popup entry point.
- `popup.html`, `popup.css`, `popup.js`: controls, MAIN-world injection, saving and retry.
- `extractor.js`: adapted Weavy store discovery and loss-aware normalization.
- `archive.js`: media fetching, records, CSV and archive assembly.
- `zip.js`: unchanged upstream STORE-mode ZIP helper.
- `tests/verify.mjs`: offline tests using built-in Node APIs only.
- `VENDORED.md`: where the carried code came from.
- `LICENSE`, `CHANGELOG.md`, `.gitignore`, `README.md`: project documentation.

MIT, copyright 2026 Colin Byrne. See [LICENSE](LICENSE).
`zip.js` and the extractor come from the author's own earlier tool; see
[VENDORED.md](VENDORED.md).
