# Prototype Concept

## Goal

Build a small prototype consisting of several applications. An agent should be able to send content and interactive tasks to a user's browser, then retrieve the user's interactions as structured data.

## System Components

### Storage and Communication Service

An ASP.NET Core HTTP service with a simple filesystem-backed store. The service accepts data from an agent and saves it under a `session-id`. For the prototype, files and metadata can be stored in a local directory; a separate database is not required.

The service provides endpoints that allow an agent to:

- send an image;
- send Markdown;
- send a WASM module and the resources it needs to render;
- create an interactive request with an ID;
- check the request's status and retrieve its interaction result by ID.

### Web UI

The web application connects to the ASP.NET Core service and receives updates through ASP.NET Core SignalR. In the single-user prototype, it shows an open tab for every active session, with each tab displaying the content and interactive requests for that session.

The user can close a session tab. Closing a session removes the tab and deletes all data for that session. If the agent later sends new content with the same `session-id`, the UI creates a new tab for it.

## Interactive Requests

An interactive request contains a unique ID and a WASM module, delivered to the browser as bytes.

Rendering agent-provided WASM is the Web UI application's responsibility. The application will support modules that follow a defined contract or target a specific, supported runtime; arbitrary WASM binaries are not expected to render themselves. A .NET Blazor-based runtime is one candidate to investigate: it may provide a way for compatible components to render through a host that manages the browser DOM. The prototype must establish what the agent needs to provide (for example, a WASM module, runtime-compatible component, generated JavaScript, and assets) and how the host invokes the component and receives its result.

The agent should be able to provide a custom task UI, including the action that completes the interaction, and code that produces a final JSON result containing the user's selections or actions. The supported module contract/runtime and its security boundaries are central prototype questions. Executing agent-provided code is a major security risk and must be treated as such, not assumed to be safe by default.

## Session Layout

When the agent sends content to display, it also sends a layout with `RowsCount`, `ColumnsCount`, and a set of elements. Rows and columns divide the available space equally. Each element represents one content item and specifies `Grid.Row`, `Grid.Column`, `Grid.RowSpan`, and `Grid.ColumnSpan`, following a positioning model similar to WPF's grid layout. Row and column indices are zero-based, as in WPF. The Web UI is responsible for rendering the elements in the specified grid positions.

The layout can combine images, Markdown, and interactive WASM elements. A new layout/content update replaces the entire current view for that session and cancels any pending interactions in the replaced view. Waiting agent requests for those interactions are released with a cancelled status.

Interaction flow:

1. The agent sends a request associated with a session and receives its ID.
2. The Web UI receives the request and displays it in the corresponding tab.
3. The user interacts with the interface provided by the module.
4. When the user activates the module-defined completion action, the result is sent to the service and saved as JSON under the request ID.
5. The agent uses a long-polling request to wait for and retrieve the result by ID. The request waits until completion or cancellation.

If the user closes a session, the service deletes all data for it, cancels its pending interactions, and releases any agent long-polling requests waiting on those interactions with a cancelled status. A later submission using the same `session-id` creates a new session.

For example, the agent sends a task to choose three cards out of seven. The user selects the cards in the browser, the module produces JSON with the selected cards, and the agent retrieves that result by the task ID.

Ordinary content, such as images and Markdown, can be displayed without interaction. Interactive WASM content is used when a user action is required.

## Expected Data Model

- **Session** — a container for content and requests, identified by `session-id`.
- **Content item** — an image, Markdown/text, or interactive WASM content, with metadata and a creation time.
- **Session layout** — a grid definition and its positioned content items; a new update replaces the current layout and its items for that session, cancelling pending interactions in the replaced view.
- **Interactive request** — a content item with a unique ID and a status, such as `pending`, `completed`, `cancelled`, or `failed`.
- **Result** — JSON produced after interaction and made available to the agent by request ID.

## Prototype Scope

- One ASP.NET Core service and one Web UI application.
- Data is stored in a local directory, restored when the service restarts, and deleted when the user closes its session; closing cancels pending interactions. Pending interactions survive a service restart, though in-flight long-poll connections must reconnect.
- Supported content: images, Markdown, and interactive WASM modules that conform to the Web UI's supported contract/runtime.
- The agent supplies a WPF-like grid layout (`RowsCount`, `ColumnsCount`, and per-element row/column positions and spans); rows and columns are equally sized, indices are zero-based, each element represents one content item, and the Web UI renders the layout. Each new update replaces the session's existing layout and content, cancelling its pending interactions.
- ASP.NET Core SignalR delivers new content and session updates to the UI.
- The agent uses long polling to wait until an interaction completes or is cancelled; results are returned as JSON over HTTP.
- The prototype assumes one trusted user on a local or private setup. The HTTP service does not require agent authentication. Active sessions and their content are restored from the filesystem when the service restarts. Pending interactions are restored as pending; the UI can continue them and the agent reconnects its long-poll request.
- A .NET Blazor-based runtime is a candidate for rendering compatible WASM-driven UI and needs to be evaluated in the prototype.
- The exact endpoint formats, layout element schema, and WASM execution/runtime interface will be decided during API design and prototyping.

Since WASM code is provided by the agent and runs in the browser, its execution and its communication with the host must be investigated carefully. The prototype must explicitly test the security boundaries and must not assume that browser execution alone makes agent-provided modules safe.
