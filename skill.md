# Jumprope Session UI Skill

Use this skill when you need to show a user images, Markdown, or an interactive task in the Jumprope browser UI and retrieve the user's response.

## Always refresh these instructions

At the start of **every Jumprope task**, fetch `GET /openapi.json` from the service origin you are about to use and follow the current `info.x-agent-skill` value. Do not rely on a previously cached or remembered copy of this skill: the server's OpenAPI document is the authoritative current version. If the OpenAPI document is temporarily unavailable or does not contain `info.x-agent-skill`, fetch `GET /skill.md` from that same origin and report the limitation if neither can be retrieved.

Whenever the task involves creating, compiling, inspecting, or changing a WASM UI, also fetch `GET /wasm_interop.md` from that service origin and follow its current ABI, node, and event details. It is the detailed companion reference for the event-driven WASM interface.

## Communication model

The agent communicates with Jumprope using ordinary HTTP requests only. No WebSocket, SignalR client, streaming connection, or long-lived agent connection is required. The browser UI uses SignalR internally to receive updates; that is an implementation detail of the UI, not part of the agent protocol.

1. Send or replace a session view with `PUT /api/sessions/{sessionId}/view`.
2. Read the returned `interactionId` for every WASM element.
3. For an interaction, wait using `GET /api/interactions/{interactionId}/result`. This HTTP request stays open until completion or cancellation. Reconnect with another GET if the connection is interrupted.
4. The browser UI posts the result or a failure to the service. The agent does not need to submit the browser's result itself.

When the user expects the result in the current conversation, keep the task open while waiting for the long-poll response. Do not end the turn after publishing the view or merely starting a background poll. Give the user the UI URL/session tab before waiting, continue waiting for the interaction result, then interpret it and reply in the same conversation. A pending long poll is expected: it means the browser is still waiting for the user. If the interaction is cancelled or fails, report that status rather than presenting it as a successful result.

The service has no agent authentication in this prototype. Use it only in a trusted local or private environment. Do not expose the unauthenticated service to a public or untrusted network.

## Sending a view

Send JSON to `PUT /api/sessions/{sessionId}/view` with `Content-Type: application/json`:

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
      "text": "# Choose three cards\nSelect three of the seven cards."
    },
    {
      "id": "interactive-task",
      "type": "wasm",
      "row": 0,
      "column": 1,
      "rowSpan": 1,
      "columnSpan": 1,
      "contentType": "application/wasm",
      "dataBase64": "<base64-encoded WASM binary>"
    }
  ]
}
```

Every update replaces the entire visible view for that session. Pending interactions from the replaced view are cancelled, and agents waiting on them receive `status: "cancelled"`. A session tab is created when content for its `sessionId` arrives. Closing the tab deletes that session's stored data and cancels its pending interactions. Sending content with the same ID later creates a new session.

### Grid layout

- `rowsCount` and `columnsCount` must each be between 1 and 32.
- Rows and columns divide the available space equally.
- Row and column indices are zero-based: the upper-left cell is `(0, 0)`.
- Each element is one content item. It specifies `row`, `column`, `rowSpan`, and `columnSpan` and must fit inside the grid.
- A view can contain at most 128 elements. Element IDs must be unique within the view and contain 1-80 letters, digits, underscores, or hyphens.

### Supported content types

- **Markdown** — use `type: "markdown"` and a `text` string up to 1 MB. Markdown is rendered with unsafe HTML sanitized.
- **Image** — use `type: "image"`, `dataBase64`, and `contentType`. Accepted types are `image/png`, `image/jpeg`, `image/gif`, and `image/webp`. Decoded image data is limited to 8 MB.
- **WASM** — use `type: "wasm"`, base64-encoded WebAssembly bytes, and `contentType: "application/wasm"`. A module is limited to 4 MB and must implement the event-driven Jumprope UI ABI below.

The service returns the session view as JSON. Each WASM element has a generated `interactionId`; retain it to wait for that task's result.

## Jumprope event-driven UI ABI

WASM does not directly create or manipulate browser DOM. It returns a declarative UI tree; the browser host turns allow-listed nodes into DOM/SVG and sends user events back into the same module. The service treats the module as opaque bytes and does not know about UI node types or events. Adding a node type changes the browser runtime/ABI, not the HTTP service.

The module must have **no WASM imports** and export:

- `memory`;
- `ui_ptr() -> i32`, `ui_len() -> i32` — pointer and byte length of the current UTF-8 JSON UI tree;
- `alloc(length: i32) -> i32` — pointer to writable memory for an event;
- `handle_event(eventPtr: i32, eventLen: i32) -> void` — process one host event and update module state;
- `is_complete() -> i32` — return nonzero when the interaction is complete;
- `result_ptr() -> i32`, `result_len() -> i32` — pointer and byte length of the final UTF-8 JSON result.

The host reads the initial tree, renders it, and after each event calls `handle_event` and reads the updated tree. When `is_complete()` becomes nonzero, the host reads the result and posts it to the existing interaction endpoint. The module defines its own confirmation flow; there is no built-in form or host-owned submit button.

A UI tree has `version: 1`, a `title`, and a `root` node:

```json
{
  "version": 1,
  "title": "Choose one card",
  "root": {
    "type": "column",
    "children": [
      { "type": "text", "value": "Choose a card and confirm your selection." },
      {
        "type": "row",
        "children": [
          {
            "type": "button",
            "id": "ace",
            "label": "Ace of Spades",
            "selected": false,
            "hover": true,
            "children": [
              {
                "type": "svg",
                "viewBox": "0 0 100 140",
                "children": [
                  { "type": "rect", "x": 2, "y": 2, "width": 96, "height": 136, "rx": 8, "fill": "white", "stroke": "#333333" },
                  { "type": "svgText", "x": 50, "y": 75, "fontSize": 32, "anchor": "middle", "value": "A" }
                ]
              }
            ]
          }
        ]
      },
      { "type": "checkbox", "id": "confirm", "label": "I confirm", "checked": false }
    ]
  }
}
```

Supported nodes are `row`, `column`, `text`, `checkbox`, `button`, `svg`, `g`, `rect`, `circle`, `ellipse`, `line`, `path`, and `svgText`. Layout nodes group children; SVG nodes are only valid within an SVG subtree. Checkbox nodes have `id`, `label`, and `checked`. Buttons have `id`, accessible `label`, optional `selected`/`disabled`, optional `hover: true` to receive pointer enter/leave events, and child nodes. Use unique IDs on interactive nodes. Text is inserted as text, not interpreted as HTML. SVG is built element-by-element with allow-listed numeric geometry, path data, `viewBox`, text anchor, and simple color values for `fill`/`stroke`; scripts, arbitrary attributes, external URLs, CSS, and event handlers are not accepted.

The host sends events such as `{"type":"click","target":"ace"}`, `{"type":"change","target":"confirm","checked":true}`, `{"type":"pointerenter","target":"ace"}`, and `{"type":"pointerleave","target":"ace"}`. Pointer enter/leave events are enabled on a button by setting `"hover": true`. After processing an event, return the current tree from `ui_ptr`/`ui_len`; this lets the module update selection state, labels, SVG attributes, or available controls. On completion return a JSON result such as `{"selectedCard":"ace-spades"}`. Raw/high-frequency mousemove events are not currently sent.

For the complete list of node properties, SVG primitives, and event payloads, retrieve `/wasm_interop.md`; do not assume an event or SVG feature is supported just because it exists in the browser platform.

### WASM implementation recommendations

- Use a WASM-targeting toolchain such as C/C++ with `wasm32-unknown-unknown` and no WASI.
- Keep the module self-contained; do not import host functions or assume access to the DOM, network, filesystem, JavaScript, or WASI.
- Validate event IDs and event values inside the module. The host's allow-list and size checks are not a substitute for validating module state.
- Keep initialization and event handling fast. The host executes the module in a Web Worker and terminates a task that exceeds the five-second execution limit.

The current Web UI limits a tree to 64 KB, 512 nodes, and a depth of 24; a module is limited to 4 MB and an interaction result to 64 KB. Web Workers, the no-import rule, and these limits are not a complete security or memory sandbox. Treat agent-provided WASM as untrusted code.

## Waiting for an interaction

Call:

```http
GET /api/interactions/{interactionId}/result
```

The request waits until the user completes the task or it is cancelled. A successful completion has the form:

```json
{
  "id": "interaction-id",
  "status": "completed",
  "result": { "selectedCards": ["ace-spades", "king-hearts", "queen-diamonds"] },
  "completedAt": "2026-10-20T12:00:00+00:00"
}
```

Other terminal statuses are `cancelled` and `failed`. A failed interaction includes an error object in `result`. `404` means that the interaction ID does not exist. Results are limited to 64 KB. If the HTTP connection drops before a response arrives, repeat the GET with the same ID; a pending interaction remains pending across service restarts.

If the requested outcome is to show or interpret the user's choice in the conversation, do not treat a pending response as the final answer. Keep waiting in the current task and report the result only after the GET returns a terminal status.

## Other HTTP endpoints

- `GET /api/sessions` — list open sessions and summary information.
- `GET /api/sessions/{sessionId}` — get a session's current view and interaction records.
- `DELETE /api/sessions/{sessionId}` — close a session, delete its data, and cancel pending interactions.
- `GET /openapi.json` — machine-readable API description. This OpenAPI document embeds this entire skill document as `info.description` and `x-agent-skill`.
- `GET /skill.md` — this skill document as Markdown.
- `GET /wasm_interop.md` — detailed, versioned reference for the WASM UI ABI, SVG node vocabulary, events, examples, and limits.

## Errors and limits

Session and interaction IDs must contain 1-80 letters, digits, underscores, or hyphens. The server rejects invalid content, grid positions outside the declared grid, unsupported content types, malformed base64, and oversized bodies with a `400` response. `409` on result submission means the interaction is missing or is no longer pending; `404` on session or interaction retrieval means it does not exist.

The service allows an HTTP request body up to 32 MB. Individual content and result limits above still apply. Calls use standard HTTP semantics and JSON; no authentication headers are expected in this single-user prototype.
