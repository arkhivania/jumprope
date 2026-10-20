import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";

const projectDirectory = new URL("../src/Jumprope.Server/", import.meta.url).pathname;
const dllPath = join(projectDirectory, "bin/Debug/net10.0/Jumprope.Server.dll");
const wasm = (await readFile(new URL("./fixtures/event-driven-ui.wasm", import.meta.url))).toString("base64");
const displayWasm = (await readFile(new URL("./fixtures/display-only.wasm", import.meta.url))).toString("base64");
const sessionId = `smoke_${crypto.randomUUID().replaceAll("-", "")}`;
const persistedSessionId = `${sessionId}_restart`;
const displaySessionId = `${sessionId}_display`;
const dotnetCandidate = process.env.DOTNET_CLI_PATH ?? join(homedir(), ".dotnet/dotnet");
let server;
let baseUrl;
let hub;

try {
  await access(dllPath, constants.R_OK);
  let dotnet = "dotnet";
  try {
    await access(dotnetCandidate, constants.X_OK);
    dotnet = dotnetCandidate;
  } catch {
    // Use dotnet from PATH when the SDK is installed system-wide.
  }

  baseUrl = await startServer(dotnet);
  assert.match(await (await fetch(baseUrl)).text(), /Jumprope/);
  const [skillSource, skillResponse, openApiResponse, wasmInteropSource, wasmInteropResponse] = await Promise.all([
    readFile(new URL("../skill.md", import.meta.url), "utf8"),
    fetch(`${baseUrl}/skill.md`),
    fetch(`${baseUrl}/openapi.json`),
    readFile(new URL("../wasm_interop.md", import.meta.url), "utf8"),
    fetch(`${baseUrl}/wasm_interop.md`)
  ]);
  assert.equal(skillResponse.status, 200);
  assert.equal(await skillResponse.text(), skillSource);
  assert.equal(openApiResponse.status, 200);
  const openApi = await openApiResponse.json();
  assert.equal(openApi.openapi, "3.1.0");
  assert.equal(openApi.info["x-agent-skill"], skillSource);
  assert.equal(openApi.info.description, skillSource);
  assert.ok(openApi.paths["/api/sessions/{sessionId}/view"]);
  assert.ok(openApi.paths["/api/interactions/{interactionId}/result"]);
  assert.ok(openApi.paths["/wasm_interop.md"]);
  assert.equal(openApi.components.schemas.ElementInput.properties.interactive.default, true);
  assert.equal(wasmInteropResponse.status, 200);
  assert.equal(await wasmInteropResponse.text(), wasmInteropSource);
  await connectHub();

  const invalidId = await fetch(`${baseUrl}/api/sessions/bad%21id`);
  assert.equal(invalidId.status, 400);

  const invalidLayout = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rowsCount: 1, columnsCount: 1, elements: [{
      id: "outside", type: "markdown", row: 1, column: 0, rowSpan: 1, columnSpan: 1, text: "invalid"
    }] })
  });
  assert.equal(invalidLayout.status, 400);

  const invalidInteractiveImage = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1, columnsCount: 1, elements: [{
        id: "image", type: "image", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "image/png", dataBase64: "AA==", interactive: false
      }]
    })
  });
  assert.equal(invalidInteractiveImage.status, 400);

  const invalidWasm = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "bad-module", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: "bm90LXdhc20="
      }]
    })
  });
  assert.equal(invalidWasm.status, 400);

  const initialView = {
    rowsCount: 1,
    columnsCount: 3,
    elements: [
      { id: "intro", type: "markdown", row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: "# Choose cards" },
      {
        id: "pixel", type: "image", row: 0, column: 1, rowSpan: 1, columnSpan: 1,
        contentType: "image/png",
        dataBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
      },
      {
        id: "picker", type: "wasm", row: 0, column: 2, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm",
        dataBase64: wasm
      }
    ]
  };

  const sessionUpdated = waitForHubEvent("sessionUpdated", sessionId);
  let response = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(initialView)
  });
  assert.equal(response.status, 200);
  const savedView = await response.json();
  await sessionUpdated;
  const firstInteractionId = savedView.elements.find((element) => element.id === "picker").interactionId;
  assert.ok(firstInteractionId);
  assert.equal(savedView.elements.find((element) => element.id === "picker").interactive, true);
  assert.equal((await fetch(`${baseUrl}/api/sessions/${sessionId}`)).status, 200);

  const displayResponse = await fetch(`${baseUrl}/api/sessions/${displaySessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1, columnsCount: 1, elements: [{
        id: "display", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: displayWasm, interactive: false
      }]
    })
  });
  assert.equal(displayResponse.status, 200);
  const displayView = await displayResponse.json();
  assert.equal(displayView.elements[0].interactive, false);
  assert.equal(displayView.elements[0].interactionId, null);
  assert.equal(displayView.interactions.length, 0);

  const waitingForResult = fetch(`${baseUrl}/api/interactions/${firstInteractionId}/result`);
  response = await fetch(`${baseUrl}/api/interactions/${firstInteractionId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedCards: ["ace-spades", "queen-diamonds", "eight-diamonds"] })
  });
  assert.equal(response.status, 200);
  const completed = await (await waitingForResult).json();
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.result.selectedCards, ["ace-spades", "queen-diamonds", "eight-diamonds"]);

  const oversizedResult = await fetch(`${baseUrl}/api/interactions/${firstInteractionId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify("x".repeat(70 * 1024))
  });
  assert.equal(oversizedResult.status, 400);

  const currentView = await (await fetch(`${baseUrl}/api/sessions/${sessionId}`)).json();
  const oldInteractionIds = currentView.interactions.map((interaction) => interaction.id);
  const pendingViewResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "pending-picker", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: wasm
      }]
    })
  });
  assert.equal(pendingViewResponse.status, 200);
  const pendingView = await pendingViewResponse.json();
  const pendingInteractionId = pendingView.elements[0].interactionId;
  const waitingForCancellation = fetch(`${baseUrl}/api/interactions/${pendingInteractionId}/result`);

  response = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "replacement", type: "markdown", row: 0, column: 0, rowSpan: 1, columnSpan: 1, text: "Replaced"
      }]
    })
  });
  assert.equal(response.status, 200);
  const cancelled = await (await waitingForCancellation).json();
  assert.equal(cancelled.status, "cancelled");

  for (const oldInteractionId of oldInteractionIds) {
    const oldResult = await fetch(`${baseUrl}/api/interactions/${oldInteractionId}/result`);
    assert.equal(oldResult.status, 200);
  }

  const failedViewResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "failed-picker", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: wasm
      }]
    })
  });
  const failedView = await failedViewResponse.json();
  const failedInteractionId = failedView.elements[0].interactionId;
  const waitingForFailure = fetch(`${baseUrl}/api/interactions/${failedInteractionId}/result`);
  response = await fetch(`${baseUrl}/api/interactions/${failedInteractionId}/failure`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ error: "Sample module failure" })
  });
  assert.equal(response.status, 200);
  assert.equal((await (await waitingForFailure).json()).status, "failed");

  const pendingBeforeDeleteResponse = await fetch(`${baseUrl}/api/sessions/${sessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "delete-picker", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: wasm
      }]
    })
  });
  const pendingBeforeDelete = await pendingBeforeDeleteResponse.json();
  const deletedInteractionId = pendingBeforeDelete.elements[0].interactionId;
  const waitingForDelete = fetch(`${baseUrl}/api/interactions/${deletedInteractionId}/result`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sessionDeleted = waitForHubEvent("sessionDeleted", sessionId);
  response = await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: "DELETE" });
  assert.equal(response.status, 204);
  await sessionDeleted;
  const deletedResult = await waitingForDelete;
  assert.equal(deletedResult.status, 200);
  assert.equal((await deletedResult.json()).status, "cancelled");
  assert.equal((await fetch(`${baseUrl}/api/sessions/${sessionId}`)).status, 404);

  response = await fetch(`${baseUrl}/api/sessions/${persistedSessionId}/view`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rowsCount: 1,
      columnsCount: 1,
      elements: [{
        id: "persisted-picker", type: "wasm", row: 0, column: 0, rowSpan: 1, columnSpan: 1,
        contentType: "application/wasm", dataBase64: wasm
      }]
    })
  });
  assert.equal(response.status, 200);
  const persistedView = await response.json();
  const persistedInteractionId = persistedView.elements[0].interactionId;

  await hub.stop();
  await stopServer();
  baseUrl = await startServer(dotnet);
  await connectHub();
  const restored = await (await fetch(`${baseUrl}/api/sessions/${persistedSessionId}`)).json();
  assert.equal(restored.elements[0].interactionId, persistedInteractionId);
  assert.equal(restored.interactions.find((item) => item.id === persistedInteractionId).status, "pending");
  const waitingAfterRestart = fetch(`${baseUrl}/api/interactions/${persistedInteractionId}/result`);
  response = await fetch(`${baseUrl}/api/interactions/${persistedInteractionId}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ selectedCards: ["king-hearts", "jack-clubs", "ten-spades"] })
  });
  assert.equal(response.status, 200);
  assert.equal((await (await waitingAfterRestart).json()).status, "completed");

  const deletion = await fetch(`${baseUrl}/api/sessions/${persistedSessionId}`, { method: "DELETE" });
  assert.equal(deletion.status, 204);

  console.log("API smoke tests passed: validation, display-only and interactive WASM, long polling, cancellation, persistence, and deletion.");
} finally {
  await hub?.stop();
  if (baseUrl) {
    for (const id of [sessionId, persistedSessionId, displaySessionId]) {
      await fetch(`${baseUrl}/api/sessions/${id}`, { method: "DELETE" }).catch(() => {});
    }
  }
  await stopServer();
}

async function startServer(dotnet) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const output = [];
  server = spawn(dotnet, [dllPath, "--urls", url], {
    cwd: projectDirectory,
    env: { ...process.env, ASPNETCORE_URLS: url, DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (chunk) => output.push(chunk.toString()));
  server.stderr.on("data", (chunk) => output.push(chunk.toString()));

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Service exited before startup:\n${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return url;
      }
    } catch {
      // The service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Service did not start in time:\n${output.join("")}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) {
    return;
  }
  const current = server;
  current.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => current.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000))
  ]);
  if (current.exitCode === null) {
    current.kill("SIGKILL");
    await new Promise((resolve) => current.once("exit", resolve));
  }
  server = null;
}

async function connectHub() {
  hub = new HubConnectionBuilder()
    .withUrl(`${baseUrl}/hubs/sessions`)
    .configureLogging(LogLevel.Error)
    .build();
  await hub.start();
}

function waitForHubEvent(eventName, expectedSessionId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      hub.off(eventName, handler);
      reject(new Error(`Timed out waiting for SignalR ${eventName} event.`));
    }, 5000);
    const handler = (sessionId) => {
      if (sessionId !== expectedSessionId) {
        return;
      }
      clearTimeout(timeout);
      hub.off(eventName, handler);
      resolve();
    };
    hub.on(eventName, handler);
  });
}
