export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  slideId?: string;
}

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  info: Diagnostic[];
  valid: boolean;
}
