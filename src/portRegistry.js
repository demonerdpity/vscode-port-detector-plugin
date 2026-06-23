const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const { execFile } = require("child_process");

const FALLBACK_TCP_PORTS = buildFallbackPorts();
let cachedWslDistributions;
let cachedWindowsInteropAvailable;

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        ...options
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({ stdout, stderr });
      }
    );
  });
}

function decodeCommandText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || !value.length) {
    return "";
  }

  if (value[0] === 0xff && value[1] === 0xfe) {
    return value.subarray(2).toString("utf16le");
  }

  if (value.length >= 4 && value[1] === 0x00 && value[3] === 0x00) {
    return value.toString("utf16le");
  }

  return value.toString("utf8");
}

async function execFileAutoDecodedAsync(file, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "buffer",
      ...options
    });

    return {
      stdout: decodeCommandText(stdout),
      stderr: decodeCommandText(stderr)
    };
  } catch (error) {
    error.stdout = decodeCommandText(error.stdout);
    error.stderr = decodeCommandText(error.stderr);
    throw error;
  }
}

function buildFallbackPorts() {
  const ports = [];

  for (let port = 1; port <= 1024; port += 1) {
    ports.push(port);
  }

  for (let port = 3000; port <= 10000; port += 1) {
    ports.push(port);
  }

  for (const port of [15672, 27017, 3306, 3389, 5432, 6379, 9200, 9300]) {
    ports.push(port);
  }

  return [...new Set(ports)].sort((left, right) => left - right);
}

function normalizeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (!value) {
    return [];
  }

  return [value];
}

function safeTrim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function splitEndpoint(endpoint) {
  const cleaned = safeTrim(endpoint);
  const separatorIndex = cleaned.lastIndexOf(":");

  if (separatorIndex === -1) {
    return { address: cleaned, port: 0 };
  }

  const address = cleaned.slice(0, separatorIndex).replace(/^\[|\]$/g, "");
  const port = Number.parseInt(cleaned.slice(separatorIndex + 1), 10);

  return {
    address,
    port: Number.isFinite(port) ? port : 0
  };
}

function sortRecords(records) {
  return [...records].sort((left, right) => {
    if (left.port !== right.port) {
      return left.port - right.port;
    }

    if (left.protocol !== right.protocol) {
      return left.protocol.localeCompare(right.protocol);
    }

    if (left.pid !== right.pid) {
      return (left.pid || 0) - (right.pid || 0);
    }

    return left.address.localeCompare(right.address);
  });
}

function finalizeRecord(record) {
  const services = Array.isArray(record.services)
    ? [...new Set(record.services.map(safeTrim).filter(Boolean))]
    : [];

  return {
    id: [
      record.protocol || "UNKNOWN",
      record.address || "",
      record.port || 0,
      record.pid || "unknown"
    ].join(":"),
    protocol: record.protocol || "UNKNOWN",
    address: record.address || "",
    port: Number.isFinite(record.port) ? record.port : 0,
    state: record.state || "",
    pid: Number.isFinite(record.pid) ? record.pid : null,
    processName: safeTrim(record.processName),
    commandLine: safeTrim(record.commandLine),
    services,
    dataSource: safeTrim(record.dataSource) || "native",
    displayName: services.length
      ? `${services.join(", ")}${record.processName ? ` (${record.processName})` : ""}`
      : safeTrim(record.processName) || "Unknown process"
  };
}

function getRuntimePlatform(runtimeContext = {}) {
  return safeTrim(runtimeContext.platform) || process.platform;
}

function getCurrentWslDistroName(runtimeContext = {}) {
  return safeTrim(runtimeContext.wslDistroName) || safeTrim(process.env.WSL_DISTRO_NAME);
}

function isCurrentWsl(runtimeContext = {}) {
  return safeTrim(runtimeContext.remoteName) === "wsl" || Boolean(getCurrentWslDistroName(runtimeContext));
}

function buildCurrentLinuxTarget(runtimeContext = {}) {
  if (isCurrentWsl(runtimeContext)) {
    return buildCurrentWslTarget(runtimeContext);
  }

  const remoteName = safeTrim(runtimeContext.remoteName);
  return {
    id: "linux:current",
    kind: "linux",
    label: remoteName ? `Linux - ${remoteName}` : "Linux"
  };
}

function buildCurrentWslTarget(runtimeContext = {}) {
  const distroName = getCurrentWslDistroName(runtimeContext);

  return {
    id: distroName ? `wsl:${distroName}` : "wsl:current",
    kind: "wsl-current",
    label: distroName ? `WSL - ${distroName}` : "WSL",
    distroName
  };
}

function buildEnvironmentHint({ selectedId, activeTarget, selectionReset }) {
  if (selectedId === "auto") {
    if (selectionReset) {
      return `The saved manual selection is not available here. Auto switched to ${activeTarget.label}.`;
    }

    return `Auto detected ${activeTarget.label}.`;
  }

  return `Manual override: ${activeTarget.label}.`;
}

async function resolveEnvironmentSelection(runtimeContext = {}, requestedSelection = "auto") {
  const targets = await getAvailableTargets(runtimeContext);
  const platform = getRuntimePlatform(runtimeContext);

  if (!targets.length) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const defaultTarget = targets[0];
  let selectedId = safeTrim(requestedSelection) || "auto";
  let selectionReset = false;

  if (selectedId !== "auto" && !targets.some(target => target.id === selectedId)) {
    selectedId = "auto";
    selectionReset = true;
  }

  const activeTarget = selectedId === "auto"
    ? defaultTarget
    : targets.find(target => target.id === selectedId) || defaultTarget;

  return {
    activeTarget,
    environmentLabel: activeTarget.label,
    hint: buildEnvironmentHint({ selectedId, activeTarget, selectionReset }),
    options: [
      {
        id: "auto",
        label: `Auto (${defaultTarget.label})`
      },
      ...targets.map(target => ({
        id: target.id,
        label: target.label
      }))
    ],
    selectedId,
    selectionReset
  };
}

async function getAvailableTargets(runtimeContext = {}) {
  const platform = getRuntimePlatform(runtimeContext);

  if (platform === "win32") {
    const targets = [
      {
        id: "windows",
        kind: "windows",
        label: "Windows"
      }
    ];

    const distributions = await listWslDistributions();
    for (const distroName of distributions) {
      targets.push({
        id: `wsl:${distroName}`,
        kind: "wsl-remote",
        label: `WSL - ${distroName}`,
        distroName
      });
    }

    return targets;
  }

  if (platform === "linux") {
    if (isCurrentWsl(runtimeContext)) {
      const targets = [buildCurrentWslTarget(runtimeContext)];

      if (await canUseWindowsInterop()) {
        targets.push({
          id: "windows",
          kind: "windows-interop",
          label: "Windows"
        });
      }

      return targets;
    }

    return [buildCurrentLinuxTarget(runtimeContext)];
  }

  return [];
}

async function listWslDistributions() {
  if (cachedWslDistributions) {
    return cachedWslDistributions;
  }

  try {
    const { stdout } = await execFileAutoDecodedAsync("wsl.exe", ["-l", "-q"]);
    cachedWslDistributions = stdout
      .split(/\r?\n/)
      .map(safeTrim)
      .filter(Boolean);
  } catch {
    cachedWslDistributions = [];
  }

  return cachedWslDistributions;
}

async function canUseWindowsInterop() {
  if (typeof cachedWindowsInteropAvailable === "boolean") {
    return cachedWindowsInteropAvailable;
  }

  try {
    await execFileAsync("cmd.exe", ["/C", "ver"]);
    cachedWindowsInteropAvailable = true;
  } catch {
    cachedWindowsInteropAvailable = false;
  }

  return cachedWindowsInteropAvailable;
}

async function listPortRecords(target, runtimeContext = {}) {
  const activeTarget = target || (await resolveEnvironmentSelection(runtimeContext)).activeTarget;

  switch (activeTarget.kind) {
    case "windows":
      return sortRecords(await listWindowsPortRecords({ allowFallback: true }));
    case "windows-interop":
      return sortRecords(await listWindowsPortRecords({ allowFallback: false }));
    case "linux":
    case "wsl-current":
      return sortRecords(await listLinuxPortRecords(activeTarget.label));
    case "wsl-remote":
      return sortRecords(await listRemoteWslPortRecords(activeTarget.distroName));
    default:
      throw new Error(`Unsupported environment target: ${activeTarget.kind}`);
  }
}

async function stopPortProcess(pid, target, runtimeContext = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error("Invalid PID.");
  }

  const activeTarget = target || (await resolveEnvironmentSelection(runtimeContext)).activeTarget;

  switch (activeTarget.kind) {
    case "windows":
    case "windows-interop":
      await execFileAsync("taskkill.exe", ["/PID", String(pid), "/F", "/T"]);
      return;
    case "linux":
    case "wsl-current":
      await execFileAsync("sh", ["-lc", `kill -9 ${pid}`]);
      return;
    case "wsl-remote":
      await runWslShellCommand(activeTarget.distroName, `kill -9 ${pid}`);
      return;
    default:
      throw new Error(`Unsupported environment target: ${activeTarget.kind}`);
  }
}

async function listWindowsPortRecords(options = {}) {
  const allowFallback = options.allowFallback !== false;

  try {
    const nativeEntries = await listWindowsPortRecordsNative();
    if (nativeEntries.length > 0 || !allowFallback) {
      return nativeEntries;
    }
  } catch (error) {
    if (allowFallback) {
      return listLocalPortRecordsFallback({
        detail: getCommandFailureDetail(error),
        failureLabel: "Windows native lookup"
      });
    }

    throw new Error(`Failed to read Windows port data. ${getCommandFailureDetail(error) || error.message}`);
  }

  return listLocalPortRecordsFallback({
    detail: "Native lookup returned no rows.",
    failureLabel: "Windows native lookup"
  });
}

async function listWindowsPortRecordsNative() {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
function Split-Endpoint($endpoint) {
  $cleaned = [string]$endpoint
  $index = $cleaned.LastIndexOf(':')
  if ($index -lt 0) {
    return [pscustomobject]@{ address = $cleaned; port = 0 }
  }

  $address = $cleaned.Substring(0, $index).Trim('[', ']')
  $portText = $cleaned.Substring($index + 1)
  $port = 0
  [void][int]::TryParse($portText, [ref]$port)

  return [pscustomobject]@{
    address = $address
    port = $port
  }
}

$records = New-Object System.Collections.ArrayList

foreach ($line in (netstat -ano -p tcp)) {
  if ($line -notmatch '^\s*TCP\s+') {
    continue
  }

  $parts = (($line -replace '^\s+', '') -split '\s+')
  if ($parts.Length -lt 5) {
    continue
  }

  $state = $parts[3]
  if ($state -notmatch '^(LISTENING|渚﹀惉)$') {
    continue
  }

  $local = Split-Endpoint $parts[1]
  [void]$records.Add([pscustomobject]@{
    protocol = 'TCP'
    address = $local.address
    port = [int]$local.port
    state = 'LISTENING'
    pid = [int]$parts[4]
    dataSource = 'native'
  })
}

foreach ($line in (netstat -ano -p udp)) {
  if ($line -notmatch '^\s*UDP\s+') {
    continue
  }

  $parts = (($line -replace '^\s+', '') -split '\s+')
  if ($parts.Length -lt 4) {
    continue
  }

  $local = Split-Endpoint $parts[1]
  [void]$records.Add([pscustomobject]@{
    protocol = 'UDP'
    address = $local.address
    port = [int]$local.port
    state = 'BOUND'
    pid = [int]$parts[3]
    dataSource = 'native'
  })
}

$processMap = @{}
foreach ($item in $records) {
  $pid = [int]$item.pid
  if ($pid -le 0 -or $processMap.ContainsKey($pid)) {
    continue
  }

  $name = ''
  $path = ''

  try {
    $process = Get-Process -Id $pid -ErrorAction Stop
    $name = $process.ProcessName
    $path = $process.Path
  } catch {
  }

  $processMap[$pid] = [pscustomobject]@{
    Name = $name
    CommandLine = $path
  }
}

$result = foreach ($item in $records) {
  $proc = $processMap[[int]$item.pid]
  [pscustomobject]@{
    protocol = $item.protocol
    address = $item.address
    port = [int]$item.port
    state = $item.state
    pid = [int]$item.pid
    processName = if ($proc) { $proc.Name } else { '' }
    commandLine = if ($proc) { $proc.CommandLine } else { '' }
    services = @()
    dataSource = $item.dataSource
  }
}

$result | ConvertTo-Json -Depth 4 -Compress
`.trim();

  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script
  ]);

  const parsed = stdout.trim() ? JSON.parse(stdout) : [];
  return normalizeJsonArray(parsed).map(finalizeRecord);
}

async function listLinuxPortRecords(environmentLabel = "Linux") {
  return listLinuxPortRecordsWithRunner({
    environmentLabel,
    allowFallback: true,
    loadProcessInfo: loadLocalLinuxProcessInfo,
    runShellCommand: command => execFileAsync("sh", ["-lc", command])
  });
}

async function listRemoteWslPortRecords(distroName) {
  const runShellCommand = command => runWslShellCommand(distroName, command);

  return listLinuxPortRecordsWithRunner({
    environmentLabel: distroName ? `WSL - ${distroName}` : "WSL",
    allowFallback: false,
    loadProcessInfo: (pid, fallbackProcessName) =>
      loadRemoteLinuxProcessInfo(pid, fallbackProcessName, runShellCommand),
    runShellCommand
  });
}

async function runWslShellCommand(distroName, command) {
  const args = [];

  if (distroName) {
    args.push("-d", distroName);
  }

  args.push("--", "sh", "-lc", command);
  return execFileAutoDecodedAsync("wsl.exe", args);
}

async function listLinuxPortRecordsWithRunner({
  environmentLabel,
  allowFallback,
  loadProcessInfo,
  runShellCommand
}) {
  try {
    return await listLinuxWithSs(runShellCommand, loadProcessInfo);
  } catch (ssError) {
    try {
      return await listLinuxWithNetstat(runShellCommand, loadProcessInfo);
    } catch (netstatError) {
      const detail = getCommandFailureDetail(netstatError) || getCommandFailureDetail(ssError);

      if (allowFallback) {
        return listLocalPortRecordsFallback({
          detail,
          failureLabel: `${environmentLabel} command lookup`
        });
      }

      throw new Error(`Failed to read ${environmentLabel} port data. ${detail || netstatError.message}`);
    }
  }
}

async function listLinuxWithSs(runShellCommand, loadProcessInfo) {
  const tcpOutput = await runShellCommand("ss -H -ltnp");
  const udpOutput = await runShellCommand("ss -H -lunp");
  const cache = new Map();
  const records = [];

  for (const line of tcpOutput.stdout.split(/\r?\n/)) {
    const parsed = parseSsLine(line, "TCP");
    for (const item of parsed) {
      records.push(await enrichLinuxRecord(item, cache, loadProcessInfo));
    }
  }

  for (const line of udpOutput.stdout.split(/\r?\n/)) {
    const parsed = parseSsLine(line, "UDP");
    for (const item of parsed) {
      records.push(await enrichLinuxRecord(item, cache, loadProcessInfo));
    }
  }

  return records.map(finalizeRecord);
}

function parseSsLine(line, protocol) {
  const trimmed = safeTrim(line);
  if (!trimmed) {
    return [];
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 6) {
    return [];
  }

  const local = splitEndpoint(parts[4]);
  const processBlock = parts.slice(6).join(" ");
  const owners = parseSsOwners(processBlock);

  if (!owners.length) {
    return [
      {
        protocol,
        address: local.address,
        port: local.port,
        state: parts[1],
        pid: null,
        processName: "",
        commandLine: "",
        services: [],
        dataSource: "native"
      }
    ];
  }

  return owners.map(owner => ({
    protocol,
    address: local.address,
    port: local.port,
    state: parts[1],
    pid: owner.pid,
    processName: owner.processName,
    commandLine: "",
    services: [],
    dataSource: "native"
  }));
}

function parseSsOwners(block) {
  const owners = [];
  const seen = new Set();
  const pattern = /"([^"]+)",pid=(\d+)/g;
  let match;

  while ((match = pattern.exec(block)) !== null) {
    const pid = Number.parseInt(match[2], 10);
    if (!Number.isInteger(pid) || seen.has(pid)) {
      continue;
    }

    seen.add(pid);
    owners.push({
      pid,
      processName: match[1]
    });
  }

  return owners;
}

async function listLinuxWithNetstat(runShellCommand, loadProcessInfo) {
  const { stdout } = await runShellCommand("netstat -tunlp");
  const cache = new Map();
  const records = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = safeTrim(rawLine);
    if (!line || !/^(tcp|udp)/i.test(line)) {
      continue;
    }

    const parts = line.split(/\s+/);
    const isTcp = parts[0].toLowerCase().startsWith("tcp");
    const localIndex = 3;
    const local = splitEndpoint(parts[localIndex]);
    const state = isTcp ? parts[5] : "BOUND";
    const pidProgram = isTcp ? parts[6] : parts[5];
    const owner = parseNetstatOwner(pidProgram);

    records.push(
      await enrichLinuxRecord(
        {
          protocol: isTcp ? "TCP" : "UDP",
          address: local.address,
          port: local.port,
          state,
          pid: owner.pid,
          processName: owner.processName,
          commandLine: "",
          services: [],
          dataSource: "native"
        },
        cache,
        loadProcessInfo
      )
    );
  }

  return records.map(finalizeRecord);
}

function parseNetstatOwner(value) {
  const cleaned = safeTrim(value);
  if (!cleaned || cleaned === "-") {
    return { pid: null, processName: "" };
  }

  const separatorIndex = cleaned.indexOf("/");
  if (separatorIndex === -1) {
    return {
      pid: null,
      processName: cleaned
    };
  }

  const pid = Number.parseInt(cleaned.slice(0, separatorIndex), 10);
  return {
    pid: Number.isInteger(pid) ? pid : null,
    processName: cleaned.slice(separatorIndex + 1)
  };
}

async function enrichLinuxRecord(record, cache, loadProcessInfo) {
  if (!record.pid) {
    return record;
  }

  if (cache.has(record.pid)) {
    return {
      ...record,
      ...cache.get(record.pid)
    };
  }

  const enriched = await loadProcessInfo(record.pid, record.processName);
  cache.set(record.pid, enriched);

  return {
    ...record,
    ...enriched
  };
}

async function loadLocalLinuxProcessInfo(pid, fallbackProcessName = "") {
  const enriched = {
    processName: fallbackProcessName,
    commandLine: ""
  };

  try {
    const [comm, cmdline] = await Promise.all([
      fs.readFile(`/proc/${pid}/comm`, "utf8"),
      fs.readFile(`/proc/${pid}/cmdline`, "utf8")
    ]);

    enriched.processName = safeTrim(comm) || fallbackProcessName;
    enriched.commandLine = cmdline.replace(/\u0000/g, " ").trim();
  } catch {
    // /proc data can disappear between list and read when a process exits.
  }

  return enriched;
}

async function loadRemoteLinuxProcessInfo(pid, fallbackProcessName, runShellCommand) {
  const enriched = {
    processName: fallbackProcessName,
    commandLine: ""
  };

  try {
    const [commResult, argsResult] = await Promise.all([
      runShellCommand(`ps -p ${pid} -o comm=`),
      runShellCommand(`ps -p ${pid} -o args=`)
    ]);

    enriched.processName = safeTrim(commResult.stdout) || fallbackProcessName;
    enriched.commandLine = safeTrim(argsResult.stdout);
  } catch {
    // Remote process metadata can disappear between list and read.
  }

  return enriched;
}

function getCommandFailureDetail(error) {
  if (!error) {
    return "";
  }

  return (
    safeTrim(error.stderr) ||
    safeTrim(error.stdout) ||
    safeTrim(error.message)
  );
}

async function listLocalPortRecordsFallback({ detail, failureLabel }) {
  const hosts = buildLocalProbeHosts();
  const targets = [];

  for (const host of hosts) {
    for (const port of FALLBACK_TCP_PORTS) {
      targets.push({ host, port });
    }
  }

  const matches = await withConcurrency(targets, 256, async target => {
    const open = await probeTcpPort(target.port, target.host, 120);
    return open ? target : null;
  });

  const grouped = new Map();
  for (const match of matches) {
    const entry = grouped.get(match.port) || { addresses: new Set() };
    entry.addresses.add(match.host);
    grouped.set(match.port, entry);
  }

  return [...grouped.entries()].map(([port, entry]) =>
    finalizeRecord({
      protocol: "TCP",
      address: [...entry.addresses].join(", "),
      port,
      state: "LISTENING",
      pid: null,
      processName: "Detected listener",
      commandLine: detail
        ? `Restricted fallback scan. Process details unavailable because ${failureLabel} failed: ${detail}`
        : "Restricted fallback scan. Process details and stop actions are unavailable in this environment.",
      services: [],
      dataSource: "fallback"
    })
  );
}

function buildLocalProbeHosts() {
  const hosts = new Set(["127.0.0.1"]);
  const interfaces = os.networkInterfaces();

  for (const entries of Object.values(interfaces)) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) {
        continue;
      }

      if (entry.family === "IPv4") {
        hosts.add(entry.address);
      }
    }
  }

  return [...hosts];
}

async function probeTcpPort(port, host, timeoutMs) {
  return new Promise(resolve => {
    const socket = new net.Socket();
    let settled = false;

    const finish = open => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(open);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));

    try {
      socket.connect(port, host);
    } catch {
      finish(false);
    }
  });
}

async function withConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;

  async function run() {
    while (index < items.length) {
      const current = items[index];
      index += 1;
      const value = await worker(current);
      if (value !== null && value !== undefined) {
        results.push(value);
      }
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: workerCount }, run));
  return results;
}

module.exports = {
  listPortRecords,
  resolveEnvironmentSelection,
  stopPortProcess
};