/**
 * Flexible pipeline matching - handles variations like:
 * - "Pain Patients"
 * - "🩺 Pain Patients"
 * - "Pain"
 */

export interface PipelineMatchConfig {
  /** Case-insensitive substring to match in pipeline name */
  contains: string;
  /** Display name for the metric/dashboard */
  displayName: string;
  /** Stage name for "shown" (numerator of conversion) */
  shownStageName: string;
  /** Stage name for "success" (denominator - converted) */
  successStageName: string;
}

export const PAIN_PATIENTS_CONFIG: PipelineMatchConfig = {
  contains: "pain",
  displayName: "Pain Patients",
  shownStageName: "Showed Up",
  successStageName: "Success",
};

/**
 * Find a pipeline that matches the config (e.g. name contains "pain")
 */
export function findMatchingPipeline<T extends { name?: string; id: string }>(
  pipelines: T[],
  config: PipelineMatchConfig
): T | undefined {
  const search = config.contains.toLowerCase();
  return pipelines.find((p) =>
    (p.name ?? "").toLowerCase().includes(search)
  );
}

/**
 * Calculate conversion % from stage counts
 * Conversion = (Success / Showed Up) * 100
 */
export function calculateConversion(
  stageCounts: Record<string, number>,
  config: PipelineMatchConfig
): { shown: number; success: number; conversionPercent: number | null } {
  const shown = findStageCount(stageCounts, config.shownStageName);
  const success = findStageCount(stageCounts, config.successStageName);

  let conversionPercent: number | null = null;
  if (shown > 0) {
    conversionPercent = Math.round((success / shown) * 1000) / 10;
  }

  return { shown, success, conversionPercent };
}

/**
 * Match stage name flexibly - handles minor variations in naming.
 * Keys in counts can be stage names from API (e.g. "Showed Up", "Success")
 * or pipelineStageId.
 */
function findStageCount(
  counts: Record<string, number>,
  stageName: string
): number {
  const lower = stageName.toLowerCase().trim();
  // Exact match first
  if (stageName in counts) return counts[stageName];
  if (lower in counts) return counts[lower];
  // Partial match - key contains our search term or vice versa
  for (const [key, count] of Object.entries(counts)) {
    const keyLower = key.toLowerCase();
    if (keyLower === lower || keyLower.includes(lower) || lower.includes(keyLower)) {
      return count;
    }
  }
  return 0;
}
