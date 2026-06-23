(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    entries: [],
    environmentHint: "",
    environmentLabel: "",
    environmentOptions: [],
    environmentSelection: "auto",
    loading: false,
    statusLevel: "info",
    statusText: "Ready."
  };

  const elements = {
    portInput: document.getElementById("port-input"),
    refreshButton: document.getElementById("refresh-button"),
    clearButton: document.getElementById("clear-button"),
    summaryText: document.getElementById("summary-text"),
    statusText: document.getElementById("status-text"),
    tableBody: document.getElementById("table-body"),
    environmentSelect: document.getElementById("environment-select"),
    environmentHint: document.getElementById("environment-hint")
  };

  function setStatus(level, text) {
    state.statusLevel = level;
    state.statusText = text;
    elements.statusText.dataset.level = level;
    elements.statusText.textContent = text;
  }

  function getFilterValue() {
    return elements.portInput.value.trim();
  }

  function getVisibleEntries() {
    const query = getFilterValue();
    if (!query) {
      return state.entries;
    }

    if (!/^\d+$/.test(query)) {
      return [];
    }

    return state.entries.filter(entry => String(entry.port).includes(query));
  }

  function renderEnvironmentSelector() {
    const options = Array.isArray(state.environmentOptions) ? state.environmentOptions : [];
    const selectedValue = state.environmentSelection || "auto";

    elements.environmentSelect.innerHTML = "";
    for (const item of options) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.label;
      elements.environmentSelect.appendChild(option);
    }

    if (options.some(item => item.id === selectedValue)) {
      elements.environmentSelect.value = selectedValue;
    } else if (options.length) {
      elements.environmentSelect.value = options[0].id;
    }

    elements.environmentSelect.disabled = state.loading || !options.length;
    elements.environmentHint.textContent = state.environmentHint || state.environmentLabel || "Unknown environment.";
  }

  function render() {
    const filterValue = getFilterValue();
    const invalidFilter = filterValue && !/^\d+$/.test(filterValue);
    const visibleEntries = invalidFilter ? [] : getVisibleEntries();

    renderEnvironmentSelector();
    elements.tableBody.innerHTML = "";
    elements.statusText.dataset.level = state.statusLevel;
    elements.statusText.textContent = state.statusText;

    if (invalidFilter) {
      elements.summaryText.textContent = `Showing 0 of ${state.entries.length} ports.`;
      setStatus("warning", "Port search only accepts digits.");
      renderEmptyRow("Invalid filter. Use digits only.");
      return;
    }

    elements.summaryText.textContent = `Showing ${visibleEntries.length} of ${state.entries.length} ports.`;

    if (state.statusLevel === "error") {
      renderEmptyRow(state.statusText || "Failed to load port data.");
      return;
    }

    if (!state.loading && !visibleEntries.length) {
      if (state.entries.length) {
        setStatus("info", "No ports match the current filter.");
        renderEmptyRow("No matching ports.");
      } else {
        setStatus("info", "No listening or bound ports were found.");
        renderEmptyRow("No port records available.");
      }
      return;
    }

    for (const entry of visibleEntries) {
      const row = document.createElement("tr");
      appendTextCell(row, entry.protocol);
      appendTextCell(row, entry.address || "*");
      appendTextCell(row, String(entry.port));
      appendTextCell(row, entry.state || "");
      appendTextCell(row, entry.pid ? String(entry.pid) : "-");
      appendTextCell(row, entry.displayName || "Unknown process");
      appendTextCell(row, entry.commandLine || "Command line or executable path unavailable", "command-cell");

      const actionCell = document.createElement("td");
      const stopButton = document.createElement("button");
      stopButton.type = "button";
      stopButton.textContent = "Stop";
      stopButton.disabled = !entry.pid || state.loading;
      stopButton.addEventListener("click", () => {
        vscode.postMessage({
          type: "stopProcess",
          payload: entry
        });
      });
      actionCell.appendChild(stopButton);
      row.appendChild(actionCell);

      elements.tableBody.appendChild(row);
    }
  }

  function appendTextCell(row, text, className) {
    const cell = document.createElement("td");
    if (className) {
      cell.className = className;
    }
    cell.textContent = text;
    row.appendChild(cell);
  }

  function renderEmptyRow(message) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 8;
    cell.className = "empty-row";
    cell.textContent = message;
    row.appendChild(cell);
    elements.tableBody.appendChild(row);
  }

  function requestData() {
    vscode.postMessage({ type: "requestData" });
  }

  elements.refreshButton.addEventListener("click", requestData);
  elements.clearButton.addEventListener("click", () => {
    elements.portInput.value = "";
    render();
  });
  elements.portInput.addEventListener("input", render);
  elements.environmentSelect.addEventListener("change", () => {
    vscode.postMessage({
      type: "setEnvironmentSelection",
      payload: {
        selectionId: elements.environmentSelect.value
      }
    });
  });

  window.addEventListener("message", event => {
    const message = event.data;

    switch (message?.type) {
      case "loading":
        state.loading = Boolean(message.payload?.active);
        elements.refreshButton.disabled = state.loading;
        elements.clearButton.disabled = state.loading;
        elements.portInput.disabled = state.loading;
        if (state.loading) {
          setStatus("info", "Refreshing port data...");
        }
        render();
        break;
      case "data":
        state.entries = Array.isArray(message.payload?.entries) ? message.payload.entries : [];
        state.environmentHint = message.payload?.environmentHint || "";
        state.environmentLabel = message.payload?.environmentLabel || "";
        state.environmentOptions = Array.isArray(message.payload?.environmentOptions)
          ? message.payload.environmentOptions
          : [];
        state.environmentSelection = message.payload?.environmentSelection || "auto";
        if (state.statusLevel === "error") {
          state.statusLevel = "info";
          state.statusText = "Ready.";
        }
        render();
        break;
      case "status":
        setStatus(message.payload?.level || "info", message.payload?.text || "");
        render();
        break;
      default:
        break;
    }
  });

  requestData();
})();