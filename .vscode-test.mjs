import { defineConfig } from '@vscode/test-cli';
import { dirname, join } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	workspaceFolder: join(__dirname, 'schema'),
	launchArgs: [
		// 실제 웹뷰 테스트가 다른 창에 가려져도 timer/RAF가 멈추지 않게 한다.
		// 제품의 HTML·스크립트·CSP는 바꾸지 않고 테스트 호스트에만 적용한다.
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
		// test-cli가 뒤에 붙이는 workspace 경로를 미등록 Chromium 옵션의
		// 값으로 소비하지 않도록 VS Code가 아는 옵션을 마지막에 둔다.
		`--user-data-dir=${join(tmpdir(), `taskhub-user-data-${process.pid}`)}`,
	],
});
