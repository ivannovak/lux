// Which row is stored when one operational id is extracted more than once.
//
// Operational ids name a thing by what the framework calls it (`opb:event:<class>`,
// `opb:command:<name>`, `opb:job:<class>`), so several files, and several extractors, can emit the
// same id. Each kind has one rule, and none of them reads the order the files were processed in:
//
//   event      One boundary per event class. Laravel adds every registration to the dispatcher,
//              so the registrations of all files are merged by the event extractor: the contract
//              lists every registering file (`registeredIn`) and every listener, and `file_path`
//              is the first registering file by path.
//   command    A class that declares a command name is a declaration; the scheduler's
//              `->command('name')` is a reference to it and carries no file. The declaration is
//              stored. Two files that declare one name are each stored under a file-qualified id
//              (identity/file-qualified-id.ts) by the command extractor: Artisan keeps the class
//              registered last, an order no source file states. The scheduler's reference then
//              stays on the unqualified name, which names neither class.
//   job        One boundary per job class, with no file. The scheduler states a job outright
//              (tier 5); a dispatch site is an inference (tier 4). The higher tier is stored, for
//              the boundary, its handler and its HANDLED_BY edge. Dispatch sites of one tier that
//              disagree on transport settle the HANDLED_BY edge by TRANSPORT_PRECEDENCE; each
//              site's own transport stays on its DISPATCHES edge.
//   schedule   Ids carry file and line, so two files cannot share one.
//
// Stated as one order over rows: a row with a file outranks one without, then the higher trust
// tier, then the transport precedence. Two rows the order cannot separate that still differ are
// two declarations of one id that an extractor failed to merge or qualify: the first by path (or
// by payload text) is stored and the run warns with the id and the files.

import { compareCodeUnits } from '../../scan-order.js';
import type { Reporter } from '../../reporter.js';
import type {
  OperationalBoundaryDescriptor,
  OperationalContractDescriptor,
  OperationalEdgeDescriptor,
  OperationalHandlerDescriptor,
  OperationalTransport,
} from './types.js';

/** The transport a shared edge keeps when its declarations disagree, strongest first. */
const TRANSPORT_PRECEDENCE: ReadonlyArray<OperationalTransport | undefined> = [
  'queue',
  'async',
  'sync',
  'event-bus',
  undefined,
];

/** The operational rows of one run, each id settled by the rules above. */
export class OperationalRows {
  readonly boundaries = new Map<string, OperationalBoundaryDescriptor>();
  readonly handlers = new Map<string, OperationalHandlerDescriptor>();
  readonly edges = new Map<string, OperationalEdgeDescriptor>();
  readonly contracts = new Map<string, OperationalContractDescriptor>();

  private readonly boundaryFiles = new Map<string, Set<string>>();
  private readonly contractPayloads = new Map<string, Set<string>>();
  private readonly conflictSource = new Map<string, string>();

  addBoundary(boundary: OperationalBoundaryDescriptor, extractor: string): void {
    const current = this.boundaries.get(boundary.id);
    if (!current) {
      this.boundaries.set(boundary.id, boundary);
      return;
    }
    const order =
      Number(Boolean(boundary.file_path)) - Number(Boolean(current.file_path)) ||
      boundary.trust_tier - current.trust_tier;
    if (order > 0) this.boundaries.set(boundary.id, boundary);
    if (order !== 0 || !boundary.file_path || !current.file_path) return;
    if (boundary.file_path === current.file_path) return;

    const files = this.boundaryFiles.get(boundary.id) ?? new Set([current.file_path]);
    this.boundaryFiles.set(boundary.id, files.add(boundary.file_path));
    this.conflictSource.set(boundary.id, extractor);
    if (boundary.file_path < current.file_path) this.boundaries.set(boundary.id, boundary);
  }

  addHandler(handler: OperationalHandlerDescriptor): void {
    const current = this.handlers.get(handler.id);
    if (!current || handler.trust_tier > current.trust_tier) this.handlers.set(handler.id, handler);
  }

  addEdge(edge: OperationalEdgeDescriptor): void {
    const current = this.edges.get(edge.id);
    if (!current) {
      this.edges.set(edge.id, edge);
      return;
    }
    const order =
      edge.trust_tier - current.trust_tier ||
      TRANSPORT_PRECEDENCE.indexOf(current.transport) -
        TRANSPORT_PRECEDENCE.indexOf(edge.transport);
    if (order > 0) this.edges.set(edge.id, edge);
  }

  addContract(contract: OperationalContractDescriptor, extractor: string): void {
    const current = this.contracts.get(contract.id);
    if (!current) {
      this.contracts.set(contract.id, contract);
      return;
    }
    if (contract.trust_tier !== current.trust_tier) {
      if (contract.trust_tier > current.trust_tier) this.contracts.set(contract.id, contract);
      return;
    }
    const payload = contract.payload_schema ?? '';
    const currentPayload = current.payload_schema ?? '';
    if (payload === currentPayload) return;

    const payloads = this.contractPayloads.get(contract.id) ?? new Set([currentPayload]);
    this.contractPayloads.set(contract.id, payloads.add(payload));
    this.conflictSource.set(contract.id, extractor);
    if (payload < currentPayload) this.contracts.set(contract.id, contract);
  }

  /** Warn, by id, about every row that held more than one declaration no rule could merge. */
  reportConflicts(reporter: Reporter): void {
    for (const id of [...this.boundaryFiles.keys()].sort(compareCodeUnits)) {
      const files = [...this.boundaryFiles.get(id)!].sort(compareCodeUnits);
      reporter.warn(
        `operational boundary ${id} is declared in ${files.length} files (${files.join(', ')}); ` +
          `one row cannot hold both, the declaration in ${this.boundaries.get(id)!.file_path} is stored.`,
        `extractor:${this.conflictSource.get(id)}`
      );
    }
    for (const id of [...this.contractPayloads.keys()].sort(compareCodeUnits)) {
      reporter.warn(
        `operational contract ${id} was extracted with ${this.contractPayloads.get(id)!.size} ` +
          `different payloads; one row cannot hold them all, the first by text order is stored.`,
        `extractor:${this.conflictSource.get(id)}`
      );
    }
  }
}
