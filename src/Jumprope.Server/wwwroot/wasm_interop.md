# Jumprope WASM UI Interop Reference

This document describes how a Jumprope WebAssembly module constructs a display-only or interactive UI and communicates with its browser host. Refresh it from `GET /wasm_interop.md` before creating or changing a WASM interaction. Also refresh `GET /openapi.json` and follow the current `info.x-agent-skill`; older local copies may not match the running service.

The HTTP service stores and forwards WASM as opaque bytes. It does not interpret the tree or event payloads. The Web UI is the ABI host; adding a node or event requires a host/runtime change, but no service endpoint or storage change.

## ABI exports

The module must have no WASM imports and export:

| Export | Signature | Purpose |
| --- | --- | --- |
| `memory` | `WebAssembly.Memory` | Module linear memory |
| `ui_ptr` | `() -> i32` | Pointer to the current UTF-8 JSON UI tree |
| `ui_len` | `() -> i32` | Byte length of that tree |
| `alloc` | `(length: i32) -> i32` | Writable memory for an incoming event |
| `handle_event` | `(eventPtr: i32, eventLen: i32) -> void` | Process one event and update module state |
| `is_complete` | `() -> i32` | Nonzero means the interaction has completed |
| `result_ptr` | `() -> i32` | Pointer to the final UTF-8 JSON result |
| `result_len` | `() -> i32` | Byte length of the result |

At startup, the host reads and renders the tree. For each user event, it writes UTF-8 JSON into memory returned by `alloc`, calls `handle_event`, then checks `is_complete`. If incomplete, the host reads and renders the new tree. If complete, it reads the JSON result and submits it to the existing interaction-result endpoint.

## Display-only mode

Each `type: "wasm"` view element has an optional `interactive` boolean. It defaults to `true` for backwards compatibility.

- `interactive: true` (or omitted): the service creates an interaction ID; the module implements the full event/result ABI above; the agent may long-poll for the result.
- `interactive: false`: the service creates no interaction ID or pending interaction record. The module needs only `memory`, `ui_ptr`, and `ui_len`, with no `alloc`, event handler, completion flag, or result exports. The host reads and renders the initial UI tree, disables any controls it contains, terminates the worker, and submits no result. The agent should return immediately after publishing the view and must not start a result long poll.

Use display-only mode for a WASM visualization that has no user-driven behavior and returns no result. For static artwork that does not need WASM execution, prefer the simpler Markdown/SVG or image content type.

The host limits a UI tree to 64 KB, 512 nodes, and depth 24. Events and results are each limited to 64 KB. A WASM module is limited to 4 MB and a host call is subject to the five-second execution timeout.

## UI tree and nodes

The top level is:

```json
{
  "version": 1,
  "title": "Choose a card",
  "root": {
    "type": "column",
    "children": []
  }
}
```

Every node has a `type`. Container nodes have `children`. The supported types and properties are:

| Type | Properties | Purpose |
| --- | --- | --- |
| `row` | `children` | Horizontal flex layout that wraps when needed |
| `column` | `children` | Vertical flex layout |
| `text` | `value` | Plain text; never parsed as HTML |
| `checkbox` | `id`, `label`, `checked` | Native checkbox; emits `change` |
| `button` | `id`, `label`, `children`, optional `disabled`, `selected`, `hover` | Native button; emits `click`; optionally emits pointer hover events |
| `svg` | `viewBox`, optional `width`, `height`, `children` | SVG root |
| `g` | `children`, optional `fill`, `stroke` | SVG group |
| `rect` | `x`, `y`, `width`, `height`, optional `rx`, `fill`, `stroke`, `strokeWidth` | SVG rectangle |
| `circle` | `cx`, `cy`, `r`, optional `fill`, `stroke`, `strokeWidth` | SVG circle |
| `ellipse` | `cx`, `cy`, `rx`, `ry`, optional `fill`, `stroke`, `strokeWidth` | SVG ellipse |
| `line` | `x1`, `y1`, `x2`, `y2`, optional `fill`, `stroke`, `strokeWidth` | SVG line |
| `path` | `d`, optional `fill`, `stroke`, `strokeWidth` | SVG path |
| `svgText` | `x`, `y`, `value`, optional `fontSize`, `anchor`, `fill`, `stroke` | SVG text |

Layout nodes can contain normal UI nodes. `button` can contain UI/SVG children, making a drawing such as a card clickable as one control. SVG elements must be descendants of `svg` or `g`; SVG subtrees cannot contain HTML controls or layout nodes.

Use unique IDs of 1-64 letters, digits, underscores, or hyphens for interactive nodes. A button's `label` is its accessible name even when it contains only SVG artwork. `selected` sets its pressed state for assistive technology and a host visual outline. `disabled` prevents button activation. `hover: true` opts the button into pointer enter/leave notifications.

SVG accepts only the properties listed above. Geometry is numeric and bounded; path data is limited to SVG path commands; colors are simple CSS color names, hex colors, `none`, or `currentColor`. Arbitrary SVG/XML attributes, inline styles, CSS, external resources, scripts, and user-authored event handlers are not supported. For dynamic appearance, update the tree's SVG `fill`, `stroke`, geometry, or text from WASM state.

## Events

The host serializes events as compact JSON objects and passes their UTF-8 bytes to `handle_event`.

| Action | Event |
| --- | --- |
| Activate a button by mouse, touch, or keyboard | `{"type":"click","target":"node-id"}` |
| Change a checkbox | `{"type":"change","target":"node-id","checked":true}` |
| Enter a button with a hover-capable pointer | `{"type":"pointerenter","target":"node-id"}` |
| Leave a button with a hover-capable pointer | `{"type":"pointerleave","target":"node-id"}` |

Click is the semantic button activation event: native button keyboard activation also produces it. Checkbox changes report the new boolean value. Pointer enter/leave events are only sent for `button` nodes with `hover: true`; they are pointer events and do not expose coordinates. Since SVG artwork is placed inside a button, hovering or clicking its artwork activates the containing button.

The host does **not** currently emit raw `mousemove`/`pointermove`, mouse-down/up, double-click, drag, wheel, keyboard text, or per-SVG-shape events. These can generate high-volume input or require a deliberate ABI/host design. Do not depend on them. CSS `:hover`-like effects are not configurable in the tree; use `hover: true` and have WASM return an updated SVG tree when the appearance must be represented in module state.

After every non-terminal event, return the current UI tree from `ui_ptr`/`ui_len`. To avoid needless work, the host does not replace the DOM when the returned JSON tree is unchanged. Keep hover handling stateful: do not emit an update that oscillates between two trees in response to enter/leave.

## Example tree

This creates a card whose SVG border can change on hover and whose button can be selected:

```json
{
  "version": 1,
  "title": "Choose a card",
  "root": {
    "type": "row",
    "children": [
      {
        "type": "button",
        "id": "ace-spades",
        "label": "Ace of Spades",
        "selected": false,
        "hover": true,
        "children": [
          {
            "type": "svg",
            "viewBox": "0 0 100 140",
            "width": 100,
            "height": 140,
            "children": [
              { "type": "rect", "x": 2, "y": 2, "width": 96, "height": 136, "rx": 8, "fill": "#fffdf8", "stroke": "#aab2c0", "strokeWidth": 1.5 },
              { "type": "svgText", "x": 50, "y": 75, "fontSize": 36, "anchor": "middle", "fill": "#24334d", "value": "A ♠" }
            ]
          }
        ]
      }
    ]
  }
}
```

On `pointerenter`, the module can return the same tree with a highlighted `stroke`; on `pointerleave`, it can restore the original color. On `click`, it can set `selected: true`, update instructions, enable a submit button, or alter other nodes. On final submission it sets `is_complete()` and exposes a result such as `{"selectedCard":"ace-spades"}`.

The ABI test fixture under `tests/fixtures/` exercises SVG card rendering, hover, click selection, checkbox changes, and explicit completion. It exists only to validate the host contract; it is not a supported sample application. `npm run test:wasm` runs this contract check.

## Safety and implementation guidance

- Treat WASM as untrusted. The worker, import restriction, and resource limits are defense-in-depth, not a complete sandbox.
- Do not place executable code, arbitrary markup, external URLs, or secrets in the UI tree.
- Validate event JSON, target IDs, state transitions, and result data inside the module.
- Prefer click/change events to high-frequency pointer events. If a future ABI adds pointer movement or dragging, it should define throttling, coordinates, capture, cancellation, and touch behavior explicitly.
- Keep initialization and each event handler fast and deterministic. Return valid UTF-8 JSON after each event.
