/**
 * Mediblix Desktop — AI catalog resolution
 *
 * The catalog can describe several hardware tiers ("lite", and later
 * "standard"). Both the Electron main process and the backend must agree on
 * which tier is active, so resolution lives in one dependency-free module.
 *
 * The resolver deliberately still accepts a flat `models` object so tests and
 * development harnesses can pass a minimal fake catalog.
 */

function tierIds(catalog) {
  return Object.keys(catalog?.tiers || {});
}

/**
 * Picks the tier to use.
 *
 * - An explicit, known tier wins.
 * - Otherwise the catalog's default, or the first defined tier.
 * - `fallback` is true when the requested tier does not exist, so callers can
 *   explain that the machine was downgraded instead of silently pretending.
 */
function resolveTier(catalog, requestedTier = null) {
  const ids = tierIds(catalog);
  const spec = catalog?.tiers || {};

  let id = requestedTier && spec[requestedTier] ? requestedTier : null;
  if (!id) {
    if (catalog?.defaultTier && spec[catalog.defaultTier]) id = catalog.defaultTier;
    else id = ids[0] || null;
  }

  const tier = id ? spec[id] : null;
  const models = tier?.models || catalog?.models || {};

  return {
    id,
    label: tier?.label || (id ? id : "unknown"),
    tier,
    models,
    fallback: Boolean(requestedTier && id && requestedTier !== id),
    requestedTier: requestedTier || null,
  };
}

function getModelSpec(catalog, kind, requestedTier = null) {
  return resolveTier(catalog, requestedTier).models[kind] || null;
}

function getRuntimeProfile(resolved) {
  return resolved?.tier?.runtimeProfile || {};
}

/** Total bytes a tier needs on disk once installed. */
function totalBytes(resolved) {
  return Object.values(resolved?.models || {}).reduce(
    (sum, model) => sum + (model.files || []).reduce((fileSum, file) => fileSum + (file.bytes || 0), 0),
    0
  );
}

/** True when the model is a document reader rather than a general VLM. */
function isOcrModel(model) {
  return model?.capability === "ocr";
}

module.exports = {
  tierIds,
  resolveTier,
  getModelSpec,
  getRuntimeProfile,
  totalBytes,
  isOcrModel,
};
