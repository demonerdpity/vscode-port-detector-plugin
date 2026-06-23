const vscode = require("vscode");

const ENV_SELECTION_KEY = "portInspector.environmentSelection";

class PortInspectorPanelController {
  constructor(context) {
    this.context = context;
    this.extensionUri = context.extensionUri;
    this.panel = null;
    this.environmentSelection = context.workspaceState.get(ENV_SELECTION_KEY) || "auto";
    this.lastSearchQuery = "";
    this.latestEnvironmentState = null;
  }

  async open() {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active, false);
      await this.refresh();
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "portInspector.panel",
      "Port Inspector",
      {
        viewColumn: vscode.ViewColumn.Active,
        preserveFocus: false
      },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "media"),
          vscode.Uri.joinPath(this.extensionUri, "resources")
        ]
      }
    );

    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.panel.onDidDispose(() => {
      this.panel = null;
      this.lastSearchQuery = "";
      this.latestEnvironmentState = null;
    });

    this.panel.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case "requestData":
          await this.refresh();
          break;
        case "searchPorts":
          await this.setSearchQuery(message.payload?.portQuery);
          break;
        case "setEnvironmentSelection":
          await this.setEnvironmentSelection(message.payload?.selectionId);
          break;
        case "stopProcess":
          await this.confirmAndStop(message.payload);
          break;
        default:
          break;
      }
    });
  }

  async setSearchQuery(portQuery) {
    this.lastSearchQuery = normalizePortQuery(portQuery);
    await this.refresh();
  }

  async setEnvironmentSelection(selectionId) {
    const nextSelection = typeof selectionId === "string" && selectionId.trim()
      ? selectionId.trim()
      : "auto";

    this.environmentSelection = nextSelection;
    await this.context.workspaceState.update(ENV_SELECTION_KEY, nextSelection);
    await this.refresh();
  }

  async refresh() {
    if (!this.panel) {
      return;
    }

    const hasSearchQuery = Boolean(normalizePortQuery(this.lastSearchQuery));

    if (hasSearchQuery) {
      this.postMessage({
        type: "loading",
        payload: { active: true }
      });
    }

    try {
      const runtimeContext = getRuntimeContext();
      const { listPortRecords, resolveEnvironmentSelection } = require("./portRegistry");
      const environmentState = await resolveEnvironmentSelection(runtimeContext, this.environmentSelection);
      this.latestEnvironmentState = environmentState;

      if (environmentState.selectedId !== this.environmentSelection) {
        this.environmentSelection = environmentState.selectedId;
        await this.context.workspaceState.update(ENV_SELECTION_KEY, environmentState.selectedId);
      }

      const searchQuery = normalizePortQuery(this.lastSearchQuery);
      if (searchQuery !== this.lastSearchQuery) {
        this.lastSearchQuery = searchQuery;
      }

      if (!searchQuery) {
        this.postMessage({
          type: "data",
          payload: {
            entries: [],
            environmentHint: environmentState.hint,
            environmentLabel: environmentState.environmentLabel,
            environmentOptions: environmentState.options,
            environmentSelection: environmentState.selectedId,
            hasSearched: false,
            searchQuery: ""
          }
        });
        this.postMessage({
          type: "status",
          payload: {
            level: "info",
            text: `Enter a port number to search in ${environmentState.environmentLabel}.`
          }
        });
        return;
      }

      const entries = await listPortRecords(environmentState.activeTarget, runtimeContext, {
        portQuery: Number.parseInt(searchQuery, 10)
      });
      const fallbackOnly =
        entries.length > 0 && entries.every(entry => entry.dataSource === "fallback");

      this.postMessage({
        type: "data",
        payload: {
          entries,
          environmentHint: environmentState.hint,
          environmentLabel: environmentState.environmentLabel,
          environmentOptions: environmentState.options,
          environmentSelection: environmentState.selectedId,
          hasSearched: true,
          searchQuery
        }
      });

      if (!entries.length) {
        this.postMessage({
          type: "status",
          payload: {
            level: "info",
            text: `No port records found for ${searchQuery} in ${environmentState.environmentLabel}.`
          }
        });
        return;
      }

      this.postMessage({
        type: "status",
        payload: fallbackOnly
          ? {
              level: "warning",
              text: `Detected ${entries.length} port entr${entries.length === 1 ? "y" : "ies"} for ${searchQuery} in ${environmentState.environmentLabel}. Restricted mode: PID mapping and Stop are unavailable.`
            }
          : {
              level: "info",
              text: `Loaded ${entries.length} port entr${entries.length === 1 ? "y" : "ies"} for ${searchQuery} in ${environmentState.environmentLabel}.`
            }
      });
    } catch (error) {
      this.showError(error);
      this.postMessage({
        type: "status",
        payload: {
          level: "error",
          text: error.message
        }
      });
    } finally {
      if (hasSearchQuery) {
        this.postMessage({
          type: "loading",
          payload: { active: false }
        });
      }
    }
  }

  async confirmAndStop(payload) {
    const pid = Number(payload?.pid);
    const port = Number(payload?.port);
    const label = payload?.displayName || payload?.processName || "unknown process";

    if (!Number.isInteger(pid) || pid <= 0) {
      vscode.window.showWarningMessage("This entry does not expose a usable PID.");
      return;
    }

    const runtimeContext = getRuntimeContext();
    const { resolveEnvironmentSelection, stopPortProcess } = require("./portRegistry");
    const environmentState = this.latestEnvironmentState ||
      await resolveEnvironmentSelection(runtimeContext, this.environmentSelection);

    const choice = await vscode.window.showWarningMessage(
      `Kill PID ${pid} on port ${port}?`,
      {
        modal: true,
        detail: `Environment: ${environmentState.environmentLabel}\nTarget: ${label}\nThis will terminate the owning process immediately.`
      },
      "Kill Process"
    );

    if (choice !== "Kill Process") {
      return;
    }

    try {
      await stopPortProcess(pid, environmentState.activeTarget, runtimeContext);
      this.postMessage({
        type: "status",
        payload: {
          level: "info",
          text: `Killed PID ${pid} on port ${port} in ${environmentState.environmentLabel}.`
        }
      });
      await this.refresh();
    } catch (error) {
      this.showError(error);
      this.postMessage({
        type: "status",
        payload: {
          level: "error",
          text: error.message
        }
      });
    }
  }

  showError(error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[Port Inspector]", message);
    vscode.window.showErrorMessage(message);
  }

  postMessage(message) {
    this.panel?.webview.postMessage(message);
  }

  getHtml(webview) {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "styles.css")
    );

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
    />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Port Inspector</title>
  </head>
  <body>
    <section class="page-shell">
      <header class="top-strip">
        <div class="title-group">
          <div class="eyebrow">Current Environment</div>
          <h1>Port Inspector</h1>
          <div class="subtitle">Search a port in the selected environment and inspect the matching listener information.</div>
        </div>
        <div class="environment-panel">
          <div class="environment-title">Environment</div>
          <select id="environment-select" aria-label="Environment selection"></select>
          <div class="environment-hint" id="environment-hint">Auto detecting current environment...</div>
        </div>
      </header>

      <section class="controls-strip">
        <label class="field-group" for="port-input">
          <span>Port Search</span>
          <input id="port-input" type="text" inputmode="numeric" placeholder="Enter an exact port number" />
        </label>
        <div class="button-group">
          <button id="search-button" type="button">Search</button>
          <button id="clear-button" type="button">Clear</button>
        </div>
      </section>

      <section class="meta-strip">
        <div id="summary-text">Waiting for search input...</div>
        <div id="status-text">Ready.</div>
      </section>

      <section class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Protocol</th>
              <th>Address</th>
              <th>Port</th>
              <th>State</th>
              <th>PID</th>
              <th>Process</th>
              <th>Command / Path</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="table-body"></tbody>
        </table>
      </section>
    </section>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}

function normalizePortQuery(value) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return /^\d+$/.test(trimmed) ? trimmed : "";
}

function activate(context) {
  console.log("[Port Inspector] activate called");
  const controller = new PortInspectorPanelController(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("portInspector.open", async () => {
      await controller.open();
      await controller.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("portInspector.refresh", async () => {
      if (!controller.panel) {
        await controller.open();
      }

      await controller.refresh();
    })
  );

  const statusBarItem = vscode.window.createStatusBarItem("portInspector.statusBar", vscode.StatusBarAlignment.Right, 1000);
  statusBarItem.name = "Port Inspector";
  statusBarItem.text = "$(plug) Port Inspector";
  statusBarItem.tooltip = "Open Port Inspector";
  statusBarItem.command = "portInspector.open";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  if (context.extensionMode === vscode.ExtensionMode.Development) {
    vscode.window.showInformationMessage("Port Inspector activated (development mode).");
    setTimeout(() => {
      controller.open().then(() => controller.refresh()).catch(error => {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(message);
      });
    }, 400);
  }
}

function getRuntimeContext() {
  return {
    platform: process.platform,
    remoteName: vscode.env.remoteName || "",
    wslDistroName: process.env.WSL_DISTRO_NAME || ""
  };
}

function getNonce() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};