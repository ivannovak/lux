// Tranche-one feature-path renderers.
//
// The renderers are part of the official answer surface, so they enforce two
// invariants from the contract (T7, R5, R6):
//
//   1. Direct evidence and context are rendered under separate, clearly-labeled
//      sections. Adjacent / contextual signal must NOT be presented as proof of
//      the compact retrieval summary.
//   2. Failures are appended after both sections so the reader sees the answer,
//      then the explicit honesty statement.
//
// The JSON renderer is a pass-through that strips nothing — the answer object
// is itself the canonical JSON shape (FeaturePathAnswer).

import { renderFeaturePathFailures } from './failures.js';
import type {
  FeaturePathAnswer,
  FeaturePathContextItem,
  FeaturePathContracts,
  FeaturePathCrossLanguage,
  FeaturePathDirectEvidenceItem,
  FeaturePathDownstreamStep,
  FeaturePathOwnership,
  FeaturePathResolution,
  FeaturePathTarget,
} from './contract.js';
import { isFileQualifiedId } from '../../identity/file-qualified-id.js';

const DIRECT_EVIDENCE_HEADER = 'Direct evidence';
const CONTEXT_HEADER = 'Context';

/**
 * Format a FeaturePathAnswer for text output.
 *
 * Section order — locked, do not reorder:
 *   1. compact summary + confidence + overlay trust
 *   2. target / resolution
 *   3. ownership (when set)
 *   4. contracts (when set)
 *   5. direct evidence (separate section, even when empty)
 *   6. context (separate section, omitted entirely when empty)
 *   7. downstream step (when set)
 *   8. cross-language (when set)
 *   9. failures (when any apply)
 */
export function renderFeaturePathAnswerText(answer: FeaturePathAnswer): string {
  const lines: string[] = [];

  lines.push(answer.primaryAnswer.summary);
  lines.push(`Confidence: ${answer.primaryAnswer.confidence}`);
  lines.push(`Overlay Trust: ${answer.overlayTrustLevel}`);

  if (answer.target) {
    const targetLabel = answer.target.label ?? answer.target.id;
    const filePart = answer.target.filePath ? ` (${answer.target.filePath})` : '';
    const tierPart = answer.target.trustTier ? ` tier=${answer.target.trustTier}` : '';
    lines.push(`Target: ${targetLabel}${filePart}${tierPart}`);
  }

  lines.push(...renderResolutionSection(answer.resolution));

  if (answer.ownership) {
    lines.push(...renderOwnershipSection(answer.ownership));
  }

  if (answer.contracts) {
    lines.push(...renderContractsSection(answer.contracts));
  }

  lines.push(...renderDirectEvidenceSection(answer.directEvidence));
  lines.push(...renderContextSection(answer.context));

  if (answer.downstreamStep) {
    lines.push(...renderDownstreamSection(answer.downstreamStep));
  }
  if (answer.crossLanguage) {
    lines.push(...renderCrossLanguageSection(answer.crossLanguage));
  }

  lines.push(...renderFeaturePathFailures(answer.failures));

  return lines.join('\n');
}

/**
 * The JSON form of a feature-path answer is the answer object itself. This
 * helper exists so callers can stringify with consistent formatting and so
 * the public surface for "render to JSON" mirrors the text helper.
 */
export function renderFeaturePathAnswerJson(answer: FeaturePathAnswer): string {
  return JSON.stringify(answer, null, 2);
}

function renderResolutionSection(resolution: FeaturePathResolution): string[] {
  const lines: string[] = [];
  if (resolution.status === 'resolved' && resolution.matchedBy) {
    lines.push(`Resolution Match: ${resolution.matchedBy}`);
    return lines;
  }
  lines.push(`Resolution: ${resolution.status}`);
  if (resolution.candidates.length > 0) {
    lines.push(
      `Candidates:${resolution.candidates
        .map((candidate) => ` ${candidateText(candidate)}`)
        .join(',')}`
    );
    // Declarations of one route in several files share a handle; each is asked for by its label.
    const shared = resolution.candidates.find((candidate) => isFileQualifiedId(candidate.id));
    if (resolution.status === 'ambiguous' && shared) {
      lines.push(`Ask for one candidate as written, e.g. "${shared.label ?? shared.id}".`);
    }
  }
  return lines;
}

/** A candidate as listed; a declaration of a shared route also shows its route name. */
function candidateText(candidate: FeaturePathTarget): string {
  const label = candidate.label ?? candidate.id;
  return isFileQualifiedId(candidate.id) && candidate.routeName
    ? `${label} (${candidate.routeName})`
    : label;
}

function renderOwnershipSection(ownership: FeaturePathOwnership): string[] {
  const lines = ['', 'Ownership'];
  const label =
    ownership.basis === 'unresolved' ? 'unresolved ownership region' : ownership.regionName;
  lines.push(
    `- ${label} (${ownership.basis}, tier=${ownership.trustTier})${
      ownership.rationale ? ` — ${ownership.rationale}` : ''
    }`
  );
  return lines;
}

function renderContractsSection(contracts: FeaturePathContracts): string[] {
  const lines = ['', 'Contracts'];
  if (contracts.request) {
    lines.push(`- Request: ${contracts.request.label}`);
  }
  if (contracts.response) {
    lines.push(`- Response: ${contracts.response.label}`);
  }
  if (contracts.downstreamPayload) {
    lines.push(`- Downstream payload: ${contracts.downstreamPayload.label}`);
  }
  if (contracts.interactionKind) {
    lines.push(`- Interaction: ${contracts.interactionKind}`);
  }
  return lines;
}

/**
 * Render the direct-evidence section. Always emitted, even when empty, so
 * the reader can see at a glance that no proof was recovered (rather than
 * having the section silently disappear and look like an oversight).
 */
function renderDirectEvidenceSection(items: FeaturePathDirectEvidenceItem[]): string[] {
  const lines = ['', DIRECT_EVIDENCE_HEADER];
  if (items.length === 0) {
    lines.push('- none recovered');
    return lines;
  }
  for (const item of items) {
    const tier = item.trustTier !== undefined ? ` tier=${item.trustTier}` : '';
    const file = item.filePath ? ` (${item.filePath})` : '';
    lines.push(`- [${item.kind}] ${item.description}${tier}${file}`);
  }
  return lines;
}

/**
 * Render the context section. Omitted entirely when empty so adjacency is
 * never implied to be proof. The header is also distinct from direct evidence.
 */
function renderContextSection(items: FeaturePathContextItem[]): string[] {
  if (items.length === 0) return [];
  const lines = ['', CONTEXT_HEADER];
  for (const item of items) {
    const file = item.filePath ? ` (${item.filePath})` : '';
    lines.push(`- [${item.kind}] ${item.description}${file}`);
  }
  return lines;
}

function renderDownstreamSection(step: FeaturePathDownstreamStep): string[] {
  const lines = ['', 'Downstream'];
  const transportPart = step.transport ? ` ${step.transport}` : '';
  lines.push(
    `- ${step.source.label ?? step.source.id} -> ${step.target.label ?? step.target.id}: ${step.edgeType}${transportPart} tier=${step.trustTier}`
  );
  if (step.rationale) lines.push(`  ${step.rationale}`);
  return lines;
}

function renderCrossLanguageSection(crossLanguage: FeaturePathCrossLanguage): string[] {
  const lines = ['', 'Cross-language'];
  const tierPart = crossLanguage.trustTier ? ` tier=${crossLanguage.trustTier}` : '';
  lines.push(`- Status: ${crossLanguage.status}${tierPart}`);
  if (crossLanguage.rationale) lines.push(`- ${crossLanguage.rationale}`);
  return lines;
}
