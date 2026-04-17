import { defineConfig } from '@vscode/test-cli';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: join(__dirname, 'schema'),
	launchArgs: [`--user-data-dir=${join(tmpdir(), `taskhub-user-data-${process.pid}`)}`],
});
