/**
 * Mediblix Desktop — Hardware capability detection
 *
 * Decides which catalog tier this machine can actually run. The rule is
 * deliberately conservative: an 8 GB Windows laptop already spends 2–3 GB on
 * the OS and ~1 GB on Mediblix itself, so a tier is only chosen when its
 * models fit inside roughly half of installed RAM.
 *
 * No external tools are invoked: everything comes from Node's `os` module and
 * the platform/arch the app was built for. That keeps detection instant and
 * available before any window exists.
 */

const os = require("os");

const GIB = 1024 * 1024 * 1024;

/** The practical floor for running a 1.7B model beside Windows and the app. */
const MIN_RAM_BYTES = 6 * GIB;
/** Below this a machine is a bad fit even for the Lite tier: warn, don't block. */
const RECOMMENDED_RAM_BYTES = 8 * GIB;
/** Where Standard-tier models would start to be considered (future). */
const STANDARD_RAM_BYTES = 15 * GIB;
const MIN_CPU_CORES = 4;
const MIN_FREE_DISK_BYTES = 3.5 * GIB;

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/**
 * The packaged runtime differs per platform: macOS arm64 ships the Metal build,
 * everything else currently ships the CPU build, so GPU offload is disabled
 * there rather than being assumed to work.
 */
function detectAcceleration({ platform = process.platform, arch = process.arch } = {}) {
  if (platform === "darwin" && arch === "arm64") {
    return { backend: "metal", gpuLayers: 99 };
  }
  return { backend: "cpu", gpuLayers: 0 };
}

function chooseTier({ totalMemBytes, requestedTier = null, availableTiers = ["lite"] } = {}) {
  if (requestedTier && availableTiers.includes(requestedTier)) {
    return { tier: requestedTier, reason: "explicit" };
  }

  // Standard is only offered when the catalog actually ships it.
  if (totalMemBytes >= STANDARD_RAM_BYTES && availableTiers.includes("standard")) {
    return { tier: "standard", reason: "enough-memory" };
  }

  return { tier: availableTiers.includes("lite") ? "lite" : availableTiers[0] || null, reason: "default" };
}

/**
 * @returns {object} a serialisable profile; safe to pass to the backend and UI.
 */
function getHardwareProfile({
  totalMemBytes = os.totalmem(),
  cpuCount = (os.cpus() || []).length || 1,
  platform = process.platform,
  arch = process.arch,
  requestedTier = null,
  availableTiers = ["lite"],
} = {}) {
  const acceleration = detectAcceleration({ platform, arch });
  const choice = chooseTier({ totalMemBytes, requestedTier, availableTiers });

  const meetsMinimumRam = totalMemBytes >= MIN_RAM_BYTES;
  const meetsRecommendedRam = totalMemBytes >= RECOMMENDED_RAM_BYTES;
  const meetsCpuFloor = cpuCount >= MIN_CPU_CORES;

  const warnings = [];
  if (!meetsMinimumRam) {
    warnings.push(
      `This computer has ${(totalMemBytes / GIB).toFixed(1)} GB of RAM. Offline AI needs at least ${MIN_RAM_BYTES / GIB} GB (8 GB recommended).`
    );
  }
  if (!meetsCpuFloor) {
    warnings.push(
      `This computer reports ${cpuCount} CPU core${cpuCount === 1 ? "" : "s"}; offline AI is usable but slow below ${MIN_CPU_CORES} cores.`
    );
  }

  return {
    platform,
    arch,
    platformKey: platformKey(platform, arch),
    cpuCount,
    totalMemBytes,
    totalMemGb: Number((totalMemBytes / GIB).toFixed(1)),
    gpu: acceleration,
    tier: choice.tier,
    tierReason: choice.reason,
    meetsMinimum: meetsMinimumRam && meetsCpuFloor,
    meetsRecommended: meetsRecommendedRam && meetsCpuFloor,
    warnings,
    limits: {
      minRamBytes: MIN_RAM_BYTES,
      recommendedRamBytes: RECOMMENDED_RAM_BYTES,
      minCpuCores: MIN_CPU_CORES,
      minFreeDiskBytes: MIN_FREE_DISK_BYTES,
    },
  };
}

/** Thread count that leaves a core for the UI and the backend. */
function threadCountFor(cpuCount, maxThreads = 4) {
  const spare = Math.max(1, Number(cpuCount) - 1);
  return Math.max(1, Math.min(Number(maxThreads) || 4, spare));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  const gb = bytes / GIB;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

module.exports = {
  getHardwareProfile,
  detectAcceleration,
  chooseTier,
  threadCountFor,
  formatBytes,
  platformKey,
  MIN_RAM_BYTES,
  RECOMMENDED_RAM_BYTES,
  MIN_CPU_CORES,
  MIN_FREE_DISK_BYTES,
};
