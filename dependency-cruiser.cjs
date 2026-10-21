module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'core-is-pure',
      severity: 'error',
      from: { path: '^packages/core' },
      to: { path: '^packages/(host|editor|cli|mcp)' }
    },
    {
      name: 'runtime-is-pure',
      severity: 'error',
      from: { path: '^packages/runtime' },
      to: { path: '^packages/' }
    },
    {
      name: 'editor-avoids-node-adapter',
      severity: 'error',
      from: { path: '^packages/editor' },
      to: { path: '^packages/core/src/node' }
    },
    {
      name: 'host-avoids-editor',
      severity: 'error',
      from: { path: '^packages/host' },
      to: { path: '^packages/editor' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|test-results|playwright-report)/' },
    tsPreCompilationDeps: true
  }
};
