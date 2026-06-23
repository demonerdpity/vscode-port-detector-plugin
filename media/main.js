(function () {
  const vscode = acquireVsCodeApi();
  const state = {
    entries: [],
    environmentHint: "",
    environmentLabel: "",
    environmentOptions: [],
    environmentSelection: "auto",
    hasSearched: false,
    loading: false,
    searchQuery: "",
    statusLevel: "info",
    statusText: "Ready."
  };

  const elements = {
    portInput: document.getElementById("port-input"),
    searchButton: document.getElementById("search-button"),
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

    return state.entries.filter(entry => String(entry.port) === query);
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
    const invalidFilter = Boolean(filterValue) && !/^\d+$/.test(filterValue);
    const visibleEntries = invalidFilter ? [] : getVisibleEntries();

    renderEnvironmentSelector();
    elements.tableBody.innerHTML = "";
    elements.statusText.dataset.level = state.statusLevel;
    elements.statusText.textContent = state.statusText;

    if (invalidFilter) {
      elements.summaryText.textContent = "Search input is invalid.";
      renderEmptyRow("Invalid filter. Use digits only.");
      return;
    }

    if (!state.hasSearched) {
      elements.summaryText.textContent = "No search executed yet.";
      renderEmptyRow("Enter a port number and click Search.");
      return;
    }

    elements.summaryText.textContent = `Showing ${visibleEntries.length} of ${state.entries.length} port records for ${state.searchQuery || filterValue}.`;

    if (state.statusLevel === "error") {
      renderEmptyRow(state.statusText || "Failed to load port data.");
      return;
    }

    if (!state.loading && !visibleEntries.length) {
      renderEmptyRow(`No port records found for ${state.searchQuery || filterValue}.`);
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

  function runSearch() {
    const query = getFilterValue();

    if (!query) {
      state.entries = [];
      state.hasSearched = false;
      state.searchQuery = "";
      setStatus("info",         `Enter a port number to search in ${state.environmentLabel || "the selected environment"}.`
      );
      render();
      vscode.postMessage({
        type: "searchPorts",
        payload: {
          portQuery: ""
        }
      });
      return;
    }

    if (!/^\d+$/.test(query)) {
      setStatus("warning", "Port search only accepts digits.");
      render();
      return;
    }

    vscode.postMessage({
      type: "searchPorts",
      payload: {
        portQuery: query
      }
    });
  }

  function requestData() {
    vscode.postMessage({ type: "requestData" });
  }

  elements.searchButton.addEventListener("click", runSearch);
  elements.clearButton.addEventListener("click", () => {
    elements.portInput.value = "";
    runSearch();
  });
  elements.portInput.addEventListener("input", render);
  elements.portInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch();
    }
  });
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
        elements.searchButton.disabled = state.loading;
        elements.clearButton.disabled = state.loading;
        elements.portInput.disabled = state.loading;
        if (state.loading) {
          setStatus("info", "Searching port data...");
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
        state.hasSearched = Boolean(message.payload?.hasSearched);
        state.searchQuery = message.payload?.searchQuery || "";
        elements.portInput.value = state.searchQuery;
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