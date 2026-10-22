import { runCli } from '@htmlppt/cli';

process.exitCode = await runCli(process.argv.slice(2));
