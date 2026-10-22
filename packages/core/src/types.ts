export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  /** Generated (`sN`) or sentinel (`body`) ids are used when a slide has no data-slide-id. */
  slideId?: string;
  /** Short human-readable path such as `s2 > figure#chart`. */
  location?: string;
}

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  info: Diagnostic[];
  valid: boolean;
}
