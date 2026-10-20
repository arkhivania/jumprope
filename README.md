# Jumprope prototype

Jumprope is a small ASP.NET Core service and browser UI for receiving session views from an agent, displaying image/Markdown/WASM content in a grid, and returning interactive results as JSON.

## Run locally

Requirements: .NET 10 SDK, Node.js 20 or newer, and npm.

```sh
npm ci
npm run build:web
cd src/Jumprope.Server
dotnet run --no-launch-profile -- --urls http://localhost:5276
```

Open `http://localhost:5276`. The service stores session JSON under `src/Jumprope.Server/data`, restores it on restart, and deletes it when a session is closed.

The prototype intentionally has no agent authentication and is for a trusted local/private setup only.

The agent skill is maintained in `skill.md`, served at `GET /skill.md`, and embedded verbatim in both `info.description` and `info.x-agent-skill` in `GET /openapi.json`. At the beginning of every task, agents must fetch the current `/openapi.json` from the target service and follow its `info.x-agent-skill`, rather than rely on cached instructions. For any task that involves WASM, agents must also fetch `/wasm_interop.md`, maintained in this repository, which is served as a static Markdown file with the current UI ABI, supported SVG nodes and interaction events. Regenerate the published documentation assets with `npm run build:openapi` (also run by `npm run build:web`).

## Agent API

All session updates replace the complete view. Replacing a view or closing its session cancels any pending WASM interactions. Session IDs and element IDs must contain 1-80 letters, digits, `_`, or `-`.

### Replace a session view

`PUT /api/sessions/{sessionId}/view`

```json
{
  "rowsCount": 1,
  "columnsCount": 2,
  "elements": [
    {
      "id": "instructions",
      "type": "markdown",
      "row": 0,
      "column": 0,
      "rowSpan": 1,
      "columnSpan": 1,
      "text": "# Choose cards\nSelect three cards."
    },
    {
      "id": "interactive-task",
      "type": "wasm",
      "row": 0,
      "column": 1,
      "rowSpan": 1,
      "columnSpan": 1,
      "contentType": "application/wasm",
      "interactive": true,
      "dataBase64": "<base64-encoded WASM binary>"
    }
  ]
}
```

Images use `type: "image"`, an allowed image content type (`image/png`, `image/jpeg`, `image/gif`, or `image/webp`), and base64-encoded `dataBase64`. Markdown uses `text`. WASM modules are limited to 4 MB; images to 8 MB; a view can contain up to 128 elements on a grid up to 32 by 32. Row and column indices are zero-based, grid cells are equally sized, and elements may span multiple cells.

For static SVG artwork, prefer inline `<svg>` markup in a Markdown element; do not use WASM just to display a picture. The Markdown renderer sanitizes the SVG. If a drawing cannot be safely represented with sanitized SVG, render it to PNG and send it as an image. Use WASM when the artwork needs interactive behavior or must return a result.

WASM elements are interactive by default. Set `"interactive": true` to receive a generated `interactionId`; the browser receives view changes through SignalR at `/hubs/sessions`. Set `"interactive": false` for display-only WASM: it gets no interaction ID, needs only the `memory`, `ui_ptr()`, and `ui_len()` exports, and the agent returns immediately without waiting for a result.

### Wait for and submit an interaction result

The agent waits at `GET /api/interactions/{interactionId}/result`. It remains open until the interaction completes or is cancelled. When the user expects the result in the current conversation, keep the task open until this request returns; do not end the turn just after publishing the view. A completed interaction returns `{"id":"...","status":"completed","result":{...}}`; cancellation returns status `cancelled`. Results are limited to 64 KB.

The browser submits a result using `POST /api/interactions/{interactionId}/result` with a JSON body. If a module fails to initialize or execute, the UI reports it through `POST /api/interactions/{interactionId}/failure`; the waiting agent receives status `failed`. A session can be deleted using `DELETE /api/sessions/{sessionId}`.

## Jumprope event-driven WASM UI

WASM does not access the DOM. Each module returns a JSON tree, the Web UI renders generic allow-listed nodes, and user actions are sent back to the module as events. The service stores the WASM as opaque content; introducing new UI nodes or interaction behavior does not require service/API changes.

The tree supports `row`, `column`, `text`, `checkbox`, `button`, and SVG elements (`svg`, `g`, `rect`, `circle`, `ellipse`, `line`, `path`, `svgText`). Interactive nodes have stable IDs. A button can contain SVG children, so a card can be an SVG image inside a button. SVG accepts only allow-listed numeric geometry, path data, view boxes, text anchors, and simple `fill`/`stroke` colors—never arbitrary attributes, CSS, external URLs, or event handlers. The module owns state and completion: after each event it can return an updated UI tree, and when its `is_complete()` export reports completion, the host submits the module's JSON result through the existing interaction endpoint.

For interactive WASM, the module must have **no WASM imports** and export `memory`, `ui_ptr()`, `ui_len()`, `alloc(length)`, `handle_event(eventPtr, eventLen)`, `is_complete()`, `result_ptr()`, and `result_len()`. `ui_ptr`/`ui_len` expose the current UTF-8 JSON tree; `handle_event` processes a host event such as `{"type":"click","target":"ace"}` or `{"type":"change","target":"confirm","checked":true}`. For `"interactive": false`, only `memory`, `ui_ptr()`, and `ui_len()` are required; the host displays the initial tree without events or a result. The browser validates the tree and renders it without accepting arbitrary HTML, JavaScript, CSS, SVG attributes, or event handlers.

## Checks

```sh
dotnet build src/Jumprope.Server
npm run build:web
npm run test:wasm
npm run test:api
```

The API smoke test starts and stops a local service process and verifies content updates, result long polling, cancellation, persistence across restart, and session deletion.
