import { useEffect, useState } from "react";
import { AlertTriangle, Cpu, Sparkles, Wifi } from "lucide-react";
import aiService from "../services/aiService";

/**
 * Small, non-intrusive pill that tells the user which AI is serving them.
 *
 * Priority:
 *  1. The provider that actually answered the most recent AI request
 *     (`X-Mediblix-AI-Provider` headers / MedAgent `provider` field).
 *  2. The provider that will be used next, from `/api/ai/status`.
 *  3. A clear "AI unavailable" state with the reason in the tooltip.
 */
const AIProviderBadge = ({ className = "" }) => {
  const [status, setStatus] = useState(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [lastUsed, setLastUsed] = useState(null);

  useEffect(() => {
    let cancelled = false;

    aiService
      .getAIStatus()
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatusFailed(true);
      });

    const handleProvider = (event) => {
      if (event?.detail?.provider) setLastUsed(event.detail);
    };

    window.addEventListener("Mediblix:ai_provider", handleProvider);
    return () => {
      cancelled = true;
      window.removeEventListener("Mediblix:ai_provider", handleProvider);
    };
  }, []);

  const geminiReady = Boolean(status?.gemini?.configured && status?.internet);
  const localReady = Boolean(status?.local?.available && status?.local?.textModelReady);
  const localError = status?.local?.error || null;

  let tone = "neutral";
  let icon = <Sparkles size={12} />;
  let label = "Checking AI…";
  let title = "Checking which AI providers are available.";

  if (lastUsed) {
    if (lastUsed.provider === "local") {
      tone = "local";
      icon = <Cpu size={12} />;
      const model = lastUsed.model || status?.local?.textModel || "local model";
      label = `Local AI · ${model}`;
      title = `Answered on this computer by ${model}. No internet needed.`;
    } else if (lastUsed.provider === "gemini") {
      tone = "online";
      icon = <Wifi size={12} />;
      label = "Gemini";
      title = lastUsed.fallback
        ? `Answered by Gemini after a local fallback (${lastUsed.fallback}).`
        : "Answered by Gemini over the internet.";
    } else {
      tone = "local";
      icon = <Cpu size={12} />;
      label = lastUsed.provider === "sqlite" ? "Inventory data" : lastUsed.provider;
      title = "Answered from local Mediblix data — no AI model needed.";
    }
  } else if (geminiReady) {
    tone = "online";
    icon = <Wifi size={12} />;
    label = "Gemini ready";
    title = "Online AI is available. Local models are used automatically if Gemini fails.";
  } else if (localReady) {
    tone = "local";
    icon = <Cpu size={12} />;
    label = `Local AI ready · ${status?.local?.textModel || "model"}`;
    title = "Gemini is not configured. Everything runs offline on this computer.";
  } else if (statusFailed) {
    tone = "down";
    icon = <AlertTriangle size={12} />;
    label = "AI status unknown";
    title = "Could not reach the Mediblix backend to check AI availability.";
  } else if (status) {
    tone = "down";
    icon = <AlertTriangle size={12} />;
    label = "AI unavailable";
    title =
      localError ||
      "No AI provider is usable right now. Connect to the internet with a Gemini key, or start the local AI runtime.";
  }

  const tones = {
    online: "bg-emerald-50 text-emerald-700 border-emerald-200",
    local: "bg-sky-50 text-sky-700 border-sky-200",
    down: "bg-amber-50 text-amber-700 border-amber-200",
    neutral: "bg-gray-50 text-gray-500 border-gray-200",
  };

  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] font-semibold whitespace-nowrap ${tones[tone]} ${className}`}
    >
      {icon}
      {label}
    </span>
  );
};

export default AIProviderBadge;
