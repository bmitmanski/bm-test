import "./style.css";

const API = "/api";

// --- frontend error reporting: every uncaught browser error goes to the API logs/metrics ---
function reportClientError(message: string, stack?: string) {
  fetch(`${API}/client-errors`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, stack, url: location.href }),
    keepalive: true,
  }).catch(() => {});
}
window.addEventListener("error", (e) => reportClientError(e.message, e.error?.stack));
window.addEventListener("unhandledrejection", (e) => {
  const reason = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  reportClientError(`Unhandled rejection: ${reason.message}`, reason.stack);
});

// --- helpers ---
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

function log(label: string, status: number | string, ms?: number, detail?: string) {
  const ok = typeof status === "number" ? status < 400 : status === "ok";
  const li = document.createElement("li");
  li.className = ok ? "ok" : "fail";
  // textContent, not innerHTML: labels contain user file names.
  const cells: [string, string][] = [
    ["time", new Date().toLocaleTimeString()],
    ["badge", String(status)],
    ["", label],
    ["muted", ms !== undefined ? `${ms} ms` : ""],
  ];
  for (const [cls, text] of cells) {
    const span = document.createElement("span");
    span.className = cls;
    span.textContent = text;
    li.append(span);
  }
  if (detail) li.title = detail;
  $("#log").prepend(li);
}

async function call(label: string, path: string, init?: RequestInit) {
  const start = performance.now();
  try {
    const res = await fetch(`${API}${path}`, init);
    const text = await res.text();
    log(label, res.status, Math.round(performance.now() - start), text);
    return res;
  } catch (err) {
    log(label, "network", Math.round(performance.now() - start), String(err));
  }
}

function setStatus(id: string, value: string) {
  const el = $(`#${id}`);
  el.textContent = value;
  el.className = value === "ok" ? "ok" : value === "…" ? "" : "fail";
}

async function refreshStatus() {
  try {
    const health = await fetch(`${API}/health`).then((r) => r.json());
    setStatus("st-api", "ok");
    $("#st-version").textContent = String(health.version).slice(0, 7);
    $("#debug-disabled").hidden = health.debugRoutes;
    const ready = await fetch(`${API}/ready`).then((r) => r.json());
    setStatus("st-db", ready.db);
    setStatus("st-redis", ready.redis);
    setStatus("st-storage", ready.storage);
  } catch {
    for (const id of ["st-api", "st-db", "st-redis", "st-storage"]) setStatus(id, "fail");
  }
}

// --- actions ---
const actions: Record<string, () => unknown> = {
  visit: () => call("Visit", "/visits", { method: "POST" }),
  burst: () => Promise.all(Array.from({ length: 20 }, () => call("Visit (burst)", "/visits", { method: "POST" }))),
  "server-error": () => call("Server error", "/debug/error"),
  "db-error": () => call("Database error", "/debug/db-error"),
  validation: () =>
    call("Validation error", "/debug/validation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "missing email field" }),
    }),
  slow: () => call("Slow request", "/debug/slow?ms=2500"),
  "fe-error": () => {
    log("Browser JS error", "thrown");
    setTimeout(() => {
      throw new Error("Test frontend error triggered from UI");
    });
  },
  "fe-rejection": () => {
    log("Unhandled rejection", "thrown");
    Promise.reject(new Error("Test unhandled promise rejection"));
  },
  crash: async () => {
    if (!confirm("Really kill the API process? Docker will restart it.")) return;
    await call("Crash API", "/debug/crash", { method: "POST" });
    setTimeout(refreshStatus, 500);
    setTimeout(refreshStatus, 5000);
  },
};

document.addEventListener("click", (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action) actions[action]?.();
});

$<HTMLInputElement>("#file-input").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const form = new FormData();
  form.append("file", file);
  const res = await call(`Upload ${file.name}`, "/files", { method: "POST", body: form });
  if (res?.ok) {
    const { key } = await res.clone().json();
    await call(`Download ${file.name}`, `/files/${encodeURIComponent(key)}`);
  }
  input.value = "";
});

// --- init ---
$("#st-fe-version").textContent = (import.meta.env.VITE_APP_VERSION ?? "dev").slice(0, 7);
const grafana = $<HTMLAnchorElement>("#grafana-link");
grafana.href = `${location.protocol}//grafana.${location.host}`;
refreshStatus();
setInterval(refreshStatus, 15000);
