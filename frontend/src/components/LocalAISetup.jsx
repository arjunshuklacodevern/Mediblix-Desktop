import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, Info, Loader2 } from "lucide-react";
import aiService from "../services/aiService";

/**
 * First-run offline AI setup.
 *
 * Mediblix ships the inference runtime, but the model weights are downloaded
 * once into the user's application-data folder (never the install folder, so
 * updates cannot delete them). This card is the only place a customer needs to
 * interact with that: one button, a size, and a progress bar.
 *
 * It renders nothing once every model for the detected tier is installed.
 */
// Decimal units: these are download sizes, and they must match the figure used
// in the catalog/support material rather than a binary-GiB approximation.
const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / 1e9;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1e6)} MB`;
};

const LocalAISetup = () => {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [activeKind, setActiveKind] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  // The backend may still be starting when this page mounts (Electron starts
  // both together), so a single failed request must not hide setup forever.
  const load = useCallback(async ({ attempts = 3 } = {}) => {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const data = await aiService.getAIStatus();
        setStatus(data);
        setChecking(false);
        return data;
      } catch {
        if (attempt === attempts) {
          setStatus(null);
          setChecking(false);
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
      }
    }
    return null;
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setup = status?.setup;
  const pending = setup?.pendingKinds || [];
  const tier = setup?.tier;
  const hardware = setup?.hardware;

  if (checking || !setup || pending.length === 0) return null;

  const pendingBytes = pending.reduce(
    (sum, kind) => sum + (setup.models?.[kind]?.totalBytes || 0),
    0
  );

  const download = async (kinds) => {
    setError(null);
    for (const kind of kinds) {
      setActiveKind(kind);
      setProgress({ percent: 0 });
      try {
        await aiService.installModel(kind, (event) => {
          if (typeof event?.percent === "number") setProgress(event);
        });
      } catch (err) {
        setError(err.message || "The model download failed.");
        break;
      }
    }
    setActiveKind(null);
    setProgress(null);
    await load();
  };

  const busy = Boolean(activeKind);
  const percent = activeKind ? progress?.percent ?? 0 : 0;

  return (
    <div className="bg-white border border-sky-200 rounded-3xl p-6 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-11 h-11 bg-sky-50 text-sky-700 rounded-2xl flex items-center justify-center flex-shrink-0">
          <Cpu size={22} />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-[var(--text-primary)]">
            Set up offline AI (optional)
          </h3>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            Mediblix can read invoices and answer questions on this computer without
            internet. The AI engine is already installed; the language files are
            downloaded once and stay on this machine.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="px-2.5 py-1 rounded-full bg-sky-50 text-sky-700 border border-sky-200 font-semibold">
          {tier?.label || "Lite"} profile
        </span>
        <span className="px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 border border-gray-200 font-semibold">
          {formatBytes(pendingBytes)} download
        </span>
        {hardware && (
          <span className="px-2.5 py-1 rounded-full bg-gray-50 text-gray-600 border border-gray-200 font-semibold">
            {hardware.cpuCount} cores · {hardware.totalMemGb} GB RAM
          </span>
        )}
      </div>

      {hardware?.meetsMinimum === false && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>
            This computer is below the practical minimum for offline AI (8 GB RAM
            recommended). You can still try it, but keep other applications closed.
          </span>
        </div>
      )}

      <div className="space-y-2">
        {pending.map((kind) => {
          const model = setup.models?.[kind] || {};
          const isActive = activeKind === kind;
          return (
            <div
              key={kind}
              className="flex items-center justify-between gap-3 border border-[var(--border-soft)] rounded-2xl px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-[var(--text-primary)] truncate">
                  {model.displayName || kind}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  {kind === "text"
                    ? "Chat and text-based invoices"
                    : "Scanned pages and photographed invoices"}{" "}
                  · {formatBytes(model.totalBytes || 0)}
                </p>
              </div>
              <span className="text-xs font-semibold text-gray-500 flex-shrink-0">
                {isActive ? (
                  <span className="inline-flex items-center gap-1.5 text-sky-700">
                    <Loader2 size={14} className="animate-spin" />
                    {percent}%
                  </span>
                ) : (
                  "Not installed"
                )}
              </span>
            </div>
          );
        })}
      </div>

      {busy && (
        <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-sky-600 transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}

      {setup.scan && setup.scan.ocrEnabled === false && (
        <p className="flex items-start gap-2 text-xs text-gray-500">
          <Info size={14} className="flex-shrink-0 mt-0.5" />
          <span>
            Scanned photos and scanned PDFs are still being validated for offline
            reading. Digital PDF invoices work offline today.
          </span>
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-xs">
          <AlertTriangle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => download(pending)}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-sky-600 text-white rounded-xl text-sm font-semibold hover:opacity-90 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {busy ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
          {busy ? "Downloading…" : `Download ${formatBytes(pendingBytes)}`}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={load}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-[var(--border-soft)] rounded-xl text-sm font-medium text-[var(--text-primary)] hover:border-sky-300 transition-all disabled:opacity-50 cursor-pointer"
        >
          <CheckCircle2 size={16} />
          Check again
        </button>
        <span className="text-xs text-gray-400">
          Downloads resume if interrupted and are checksum-verified.
        </span>
      </div>
    </div>
  );
};

export default LocalAISetup;
