import * as signalR from "@microsoft/signalr";
import DOMPurify from "dompurify";
import { marked } from "marked";

const tabs = document.querySelector("#session-tabs");
const emptyState = document.querySelector("#empty-state");
const sessionView = document.querySelector("#session-view");
const sessionGrid = document.querySelector("#session-grid");
const connectionState = document.querySelector("#connection-state");
const toast = document.querySelector("#toast");

let sessions = [];
let selectedSessionId = null;
let toastTimer;
let refreshTimer;
const activeTasks = new Set();

const connection = new signalR.HubConnectionBuilder()
  .withUrl("/hubs/sessions")
  .withAutomaticReconnect()
  .build();

connection.on("sessionUpdated", (sessionId) => {
  scheduleRefresh(sessionId === selectedSessionId);
});
connection.on("sessionDeleted", (sessionId) => {
  if (sessionId === selectedSessionId) {
    selectedSessionId = null;
  }
  scheduleRefresh(false);
});
connection.on("interactionCompleted", () => scheduleRefresh(false));
connection.onreconnecting(() => setConnectionState("disconnected", "Reconnecting…"));
connection.onreconnected(() => {
  setConnectionState("connected", "Connected");
  scheduleRefresh(true);
});
connection.onclose(() => setConnectionState("disconnected", "Disconnected"));

connection.start()
  .then(() => {
    setConnectionState("connected", "Connected");
    return refreshSessions(true);
  })
  .catch((error) => {
    setConnectionState("disconnected", "Connection failed");
    showToast(`Could not connect to the service: ${error.message}`);
  });

function setConnectionState(state, label) {
  connectionState.dataset.state = state;
  connectionState.textContent = label;
}

function scheduleRefresh(refreshSelected) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => refreshSessions(refreshSelected), 100);
}

async function refreshSessions(refreshSelected) {
  try {
    sessions = await requestJson("/api/sessions");
    if (!sessions.some((session) => session.sessionId === selectedSessionId)) {
      selectedSessionId = sessions[0]?.sessionId ?? null;
      refreshSelected = true;
    }
    renderTabs();

    if (selectedSessionId && refreshSelected) {
      await loadSession(selectedSessionId);
    } else if (!selectedSessionId) {
      showEmptyState();
    }
  } catch (error) {
    showToast(`Could not load sessions: ${error.message}`);
  }
}

function renderTabs() {
  tabs.replaceChildren();
  for (const session of sessions) {
    const wrapper = document.createElement("div");
    wrapper.className = "session-tab-wrap";
    const tab = document.createElement("button");
    tab.className = "session-tab";
    tab.type = "button";
    tab.textContent = session.sessionId;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(session.sessionId === selectedSessionId));
    tab.setAttribute("aria-controls", "session-view");
    tab.addEventListener("click", () => selectSession(session.sessionId));

    const close = document.createElement("button");
    close.className = "session-tab-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close session ${session.sessionId}`);
    close.title = `Close session ${session.sessionId}`;
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      closeSession(session.sessionId);
    });

    wrapper.append(tab, close);
    tabs.append(wrapper);
  }
}

function selectSession(sessionId) {
  selectedSessionId = sessionId;
  renderTabs();
  loadSession(sessionId);
}

async function loadSession(sessionId) {
  try {
    const session = await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (sessionId !== selectedSessionId) {
      return;
    }
    renderSession(session);
  } catch (error) {
    if (error.status !== 404) {
      showToast(`Could not load session: ${error.message}`);
    }
    scheduleRefresh(false);
  }
}

function renderSession(session) {
  stopActiveTasks();
  emptyState.hidden = true;
  sessionView.hidden = false;
  sessionGrid.replaceChildren();
  sessionGrid.style.gridTemplateColumns = `repeat(${session.columnsCount}, minmax(0, 1fr))`;
  sessionGrid.style.gridTemplateRows = `repeat(${session.rowsCount}, minmax(0, 1fr))`;
  const interactions = new Map(session.interactions.map((interaction) => [interaction.id, interaction]));

  for (const element of session.elements) {
    const item = document.createElement("article");
    item.className = `content-item content-${element.type}`;
    item.style.gridRow = `${element.row + 1} / span ${element.rowSpan}`;
    item.style.gridColumn = `${element.column + 1} / span ${element.columnSpan}`;
    item.dataset.elementId = element.id;

    if (element.type === "markdown") {
      renderMarkdown(item, element.text);
    } else if (element.type === "image") {
      renderImage(item, element);
    } else if (element.type === "wasm") {
      const interaction = interactions.get(element.interactionId);
      if (interaction && interaction.status !== "pending") {
        renderInteractionStatus(item, interaction);
      } else {
        renderWasmTask(item, element);
      }
    }

    sessionGrid.append(item);
  }
}

function renderInteractionStatus(container, interaction) {
  const heading = document.createElement("h3");
  heading.textContent = `Interaction ${interaction.status}`;
  container.classList.add("wasm-task");
  container.append(heading);

  if (interaction.status === "completed" && interaction.result !== null) {
    const result = document.createElement("pre");
    result.className = "result-json";
    result.textContent = JSON.stringify(interaction.result, null, 2);
    container.append(result);
  } else if (interaction.status === "failed" && interaction.result?.error) {
    const error = document.createElement("p");
    error.className = "item-status";
    error.dataset.error = "true";
    error.textContent = interaction.result.error;
    container.append(error);
  }
}

function renderMarkdown(container, text) {
  const html = marked.parse(text ?? "", { async: false });
  container.classList.add("markdown-content");
  container.innerHTML = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["audio", "embed", "iframe", "img", "object", "source", "style", "video"],
    FORBID_ATTR: ["style"]
  });
}

function renderImage(container, element) {
  container.classList.add("image-content");
  const image = document.createElement("img");
  image.alt = element.id;
  image.src = `data:${element.contentType};base64,${element.dataBase64}`;
  container.append(image);
}

function renderWasmTask(container, element) {
  const title = document.createElement("h3");
  title.textContent = "Loading interactive task…";
  const tree = document.createElement("div");
  tree.className = "wasm-ui-tree";
  const status = document.createElement("p");
  status.className = "item-status";
  status.textContent = "Starting the WASM UI module.";
  container.classList.add("wasm-task");
  container.append(title, tree, status);

  const task = new WasmTask(element, container, title, status);
  activeTasks.add(task);
  task.start().catch((error) => task.fail(error.message));
}

async function closeSession(sessionId) {
  if (!window.confirm(`Close session "${sessionId}" and delete its data?`)) {
    return;
  }

  try {
    await requestJson(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    if (selectedSessionId === sessionId) {
      selectedSessionId = null;
    }
    await refreshSessions(true);
  } catch (error) {
    showToast(`Could not close session: ${error.message}`);
  }
}

class WasmTask {
  constructor(element, container, title, status) {
    this.element = element;
    this.container = container;
    this.title = title;
    this.status = status;
    this.worker = null;
    this.timer = null;
    this.completed = false;
    this.failureReported = false;
  }

  async start() {
    if (!this.element.interactionId) {
      throw new Error("WASM element has no interaction ID.");
    }

    const bytes = decodeBase64(this.element.dataBase64);
    this.worker = new Worker("/wasm-worker.js");
    this.worker.onmessage = (event) => this.handleWorkerMessage(event.data);
    this.worker.onerror = () => this.fail("The WASM worker failed.");
    this.timer = setTimeout(() => this.fail("The WASM task exceeded its 5-second execution limit."), 5000);
    this.worker.postMessage({ type: "init", bytes }, [bytes.buffer]);
  }

  handleWorkerMessage(message) {
    if (message.type === "ready" || message.type === "update") {
      clearTimeout(this.timer);
      const nextUi = validateUi(message.ui);
      if (JSON.stringify(nextUi) !== JSON.stringify(this.ui)) {
        this.ui = nextUi;
        this.renderUi();
      }
      this.status.textContent = "Interact with the WASM UI.";
      return;
    }

    if (message.type === "result") {
      clearTimeout(this.timer);
      this.saveResult(message.result);
      return;
    }

    if (message.type === "error") {
      this.fail(message.message);
    }
  }

  renderUi() {
    this.title.textContent = this.ui.title;
    const focusedId = document.activeElement?.dataset?.nodeId;
    const tree = renderUiNode(this.ui.root, (uiEvent) => this.dispatchUiEvent(uiEvent));
    this.container.querySelector(".wasm-ui-tree")?.replaceChildren(tree);
    const focusTarget = focusedId && [...this.container.querySelectorAll("[data-node-id]")]
      .find((node) => node.dataset.nodeId === focusedId);
    focusTarget?.focus();
  }

  dispatchUiEvent(uiEvent) {
    if (this.completed || !this.worker) {
      return;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.fail("The WASM task exceeded its 5-second execution limit."), 5000);
    this.status.textContent = "Processing interaction…";
    this.worker.postMessage({ type: "event", event: JSON.stringify(uiEvent) });
  }

  async saveResult(result) {
    if (this.completed) {
      return;
    }

    this.completed = true;
    try {
      await requestJson(`/api/interactions/${encodeURIComponent(this.element.interactionId)}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(result)
      });
      this.status.textContent = "Result sent to the agent.";
      this.container.querySelector(".wasm-ui-tree")?.remove();
      this.stopWorker();
    } catch (error) {
      this.completed = false;
      this.fail(`Could not submit result: ${error.message}`);
    }
  }

  fail(message) {
    clearTimeout(this.timer);
    this.stopWorker();
    this.status.textContent = message;
    this.status.dataset.error = "true";
    if (!this.element.interactionId || this.failureReported) {
      return;
    }

    this.failureReported = true;
    requestJson(`/api/interactions/${encodeURIComponent(this.element.interactionId)}/failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: message })
    }).catch((error) => {
      this.status.textContent = `${message} The service could not record this failure: ${error.message}`;
    });
  }

  stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    activeTasks.delete(this);
  }

  dispose() {
    clearTimeout(this.timer);
    this.stopWorker();
  }
}

const nodeTypes = new Set(["row", "column", "text", "checkbox", "button", "svg", "g", "rect", "circle", "ellipse", "line", "path", "svgText"]);
const svgTypes = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "path", "svgText"]);
const svgNumberAttributes = {
  rect: ["x", "y", "width", "height"],
  circle: ["cx", "cy", "r"],
  ellipse: ["cx", "cy", "rx", "ry"],
  line: ["x1", "y1", "x2", "y2"],
  svgText: ["x", "y"]
};
const optionalSvgNumberAttributes = {
  rect: ["rx"],
  svgText: ["fontSize"]
};
const svgColorPattern = /^(none|currentColor|#[\da-f]{3,8}|[a-z]{1,20})$/i;

function validateUi(ui) {
  if (!ui || ui.version !== 1 || typeof ui.title !== "string" || ui.title.length > 160) {
    throw new Error("Unsupported or invalid Jumprope UI tree.");
  }

  let nodeCount = 0;
  const ids = new Set();
  function validateNode(node, depth, insideSvg = false) {
    nodeCount += 1;
    if (nodeCount > 512 || depth > 24 || !node || !nodeTypes.has(node.type) ||
        (insideSvg && !svgTypes.has(node.type)) ||
        (!insideSvg && ["g", "rect", "circle", "ellipse", "line", "path", "svgText"].includes(node.type))) {
      throw new Error("Invalid or oversized node in Jumprope UI tree.");
    }
    if (["row", "column", "svg", "g", "button"].includes(node.type)) {
      if (!Array.isArray(node.children) || node.children.length > 128) {
        throw new Error(`Invalid children in ${node.type} UI node.`);
      }
    } else if (node.children !== undefined) {
      throw new Error(`${node.type} UI nodes cannot have children.`);
    }
    if (node.type === "text" && (typeof node.value !== "string" || node.value.length > 4096)) {
      throw new Error("Invalid text UI node.");
    }
    if (node.type === "checkbox" &&
        (typeof node.label !== "string" || node.label.length > 160 || typeof node.checked !== "boolean")) {
      throw new Error("Invalid checkbox UI node.");
    }
    if (node.type === "button" &&
        (typeof node.label !== "string" || node.label.length > 160 ||
         (node.disabled !== undefined && typeof node.disabled !== "boolean") ||
         (node.selected !== undefined && typeof node.selected !== "boolean") ||
         (node.hover !== undefined && typeof node.hover !== "boolean"))) {
      throw new Error("Invalid button UI node.");
    }
    if (node.type === "checkbox" || node.type === "button") {
      if (typeof node.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(node.id) || ids.has(node.id)) {
        throw new Error("Interactive UI node IDs must be unique and valid.");
      }
      ids.add(node.id);
    }
    if (node.type === "svg") {
      if (typeof node.viewBox !== "string" || !/^[\d.\s+-]{1,64}$/.test(node.viewBox)) {
        throw new Error("Invalid SVG viewBox.");
      }
      for (const dimension of ["width", "height"]) {
        if (node[dimension] !== undefined && !/^\d{1,4}(px|%)?$/.test(String(node[dimension]))) {
          throw new Error("Invalid SVG dimensions.");
        }
      }
    }
    for (const attribute of svgNumberAttributes[node.type] ?? []) {
      if (typeof node[attribute] !== "number" || !Number.isFinite(node[attribute]) ||
          Math.abs(node[attribute]) > 10000) {
        throw new Error(`Invalid SVG ${attribute} value.`);
      }
    }
    for (const attribute of optionalSvgNumberAttributes[node.type] ?? []) {
      if (node[attribute] !== undefined &&
          (typeof node[attribute] !== "number" || !Number.isFinite(node[attribute]) ||
           Math.abs(node[attribute]) > 10000)) {
        throw new Error(`Invalid SVG ${attribute} value.`);
      }
    }
    if (svgTypes.has(node.type)) {
      for (const attribute of ["fill", "stroke"]) {
        if (node[attribute] !== undefined &&
            (typeof node[attribute] !== "string" || !svgColorPattern.test(node[attribute]))) {
          throw new Error(`Invalid SVG ${attribute} value.`);
        }
      }
    }
    if (node.type === "path" &&
        (typeof node.d !== "string" || node.d.length > 4096 ||
         !/^[MmLlHhVvCcSsQqTtAaZz\d.,+\-\s]*$/.test(node.d))) {
      throw new Error("Invalid SVG path.");
    }
    if (node.anchor !== undefined &&
        (node.type !== "svgText" || !["start", "middle", "end"].includes(node.anchor))) {
      throw new Error("Invalid SVG text anchor.");
    }
    if (node.type === "svgText" &&
        (typeof node.value !== "string" || node.value.length > 256)) {
      throw new Error("Invalid SVG text node.");
    }
    if (node.strokeWidth !== undefined &&
        (typeof node.strokeWidth !== "number" || !Number.isFinite(node.strokeWidth) ||
         node.strokeWidth < 0 || node.strokeWidth > 100)) {
      throw new Error("Invalid SVG stroke width.");
    }
    for (const child of node.children ?? []) {
      validateNode(child, depth + 1, insideSvg || node.type === "svg" || node.type === "g");
    }
  }

  validateNode(ui.root, 0);
  return ui;
}

function renderUiNode(node, dispatch) {
  if (node.type === "row" || node.type === "column") {
    const element = document.createElement("div");
    element.className = `wasm-layout wasm-${node.type}`;
    element.append(...node.children.map((child) => renderUiNode(child, dispatch)));
    return element;
  }
  if (node.type === "text") {
    const element = document.createElement("p");
    element.className = "wasm-text";
    element.textContent = node.value;
    return element;
  }
  if (node.type === "checkbox") {
    const label = document.createElement("label");
    label.className = "wasm-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = node.checked;
    input.dataset.nodeId = node.id;
    input.addEventListener("change", () => dispatch({ type: "change", target: node.id, checked: input.checked }));
    const text = document.createElement("span");
    text.textContent = node.label;
    label.append(input, text);
    return label;
  }
  if (node.type === "button") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "wasm-button";
    button.disabled = node.disabled ?? false;
    button.dataset.nodeId = node.id;
    button.setAttribute("aria-label", node.label);
    if (node.selected !== undefined) {
      button.setAttribute("aria-pressed", String(node.selected));
    }
    if (node.children.length === 0) {
      button.textContent = node.label;
    } else {
      button.append(...node.children.map((child) => renderUiNode(child, dispatch)));
    }
    button.addEventListener("click", () => dispatch({ type: "click", target: node.id }));
    if (node.hover) {
      button.addEventListener("pointerenter", () => dispatch({ type: "pointerenter", target: node.id }));
      button.addEventListener("pointerleave", () => dispatch({ type: "pointerleave", target: node.id }));
    }
    return button;
  }

  const svgElementNames = { svgText: "text" };
  const element = document.createElementNS("http://www.w3.org/2000/svg", svgElementNames[node.type] ?? node.type);
  if (node.type === "svg") {
    element.setAttribute("viewBox", node.viewBox);
    for (const dimension of ["width", "height"]) {
      if (node[dimension] !== undefined) element.setAttribute(dimension, String(node[dimension]));
    }
  }
  for (const attribute of svgNumberAttributes[node.type] ?? []) {
    if (node[attribute] !== undefined) element.setAttribute(attribute === "fontSize" ? "font-size" : attribute, String(node[attribute]));
  }
  for (const attribute of ["fill", "stroke"]) {
    if (node[attribute] !== undefined) element.setAttribute(attribute, node[attribute]);
  }
  if (node.strokeWidth !== undefined) {
    element.setAttribute("stroke-width", String(node.strokeWidth));
  }
  if (node.anchor !== undefined) element.setAttribute("text-anchor", node.anchor);
  if (node.type === "path") element.setAttribute("d", node.d);
  if (node.type === "svgText") element.textContent = node.value;
  if (node.children) element.append(...node.children.map((child) => renderUiNode(child, dispatch)));
  return element;
}

function decodeBase64(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 204) {
    return null;
  }

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(body?.error ?? `Request failed with HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function showEmptyState() {
  stopActiveTasks();
  sessionView.hidden = true;
  emptyState.hidden = false;
}

function stopActiveTasks() {
  for (const task of activeTasks) {
    task.dispose();
  }
  activeTasks.clear();
}

function showToast(message) {
  toast.textContent = message;
  toast.dataset.visible = "true";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.dataset.visible = "false";
  }, 4500);
}
