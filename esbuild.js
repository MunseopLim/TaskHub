const esbuild = require("esbuild");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * `.vscode/tasks.json` 의 background 문제 매처가 읽는 시작/끝 신호를 낸다.
 *
 * **번들이 둘이어도 한 쌍만 낸다.** 설정마다 따로 내면 한 번의 빌드에 begin/end 가
 * 두 쌍 나오고, F5 의 preLaunchTask 가 **첫 번째 finished** 를 보고 빌드가 끝났다고
 * 판단해 나머지 번들이 아직 디스크에 써지는 중에 확장이 뜬다.
 *
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = (() => {
	let outstanding = 0;
	return {
		name: 'esbuild-problem-matcher',

		setup(build) {
			build.onStart(() => {
				if (outstanding === 0) {
					console.log('[watch] build started');
				}
				outstanding++;
			});
			build.onEnd((result) => {
				result.errors.forEach(({ text, location }) => {
					console.error(`✘ [ERROR] ${text}`);
					console.error(`    ${location.file}:${location.line}:${location.column}:`);
				});
				outstanding--;
				if (outstanding === 0) {
					console.log('[watch] build finished');
				}
			});
		},
	};
})();

/**
 * 확장 호스트 번들 (Node).
 */
const extensionConfig = {
	entryPoints: [
		'src/extension.ts'
	],
	bundle: true,
	format: 'cjs',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'node',
	outfile: 'dist/extension.js',
	external: ['vscode'],
	logLevel: 'silent',
	plugins: [
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
};

/**
 * JSON Editor webview 번들 (브라우저).
 *
 * webview 스크립트가 쓰는 **순수 로직의 단일 출처**를 담는다. 예전에는 같은
 * 로직이 두 벌이었다 — 하나는 `getWebviewContent` 의 템플릿 리터럴 안(타입체크도
 * 린트도 걸리지 않는 문자열), 하나는 `src/jsonEditorUtils.ts` 의 "테스트용 미러".
 * 두 벌은 반드시 어긋나므로, 이제 webview 가 미러를 **직접 불러 쓴다.**
 *
 * IIFE + globalName 이라 로드되면 전역 하나만 남긴다. 인라인 스크립트는 그
 * 전역에서 필요한 것을 꺼내 쓴다.
 */
const webviewConfig = {
	entryPoints: [
		'src/webview/jsonEditorLogic.ts'
	],
	bundle: true,
	format: 'iife',
	globalName: 'TaskHubJsonEditorLogic',
	minify: production,
	sourcemap: !production,
	sourcesContent: false,
	platform: 'browser',
	target: 'es2022',
	outfile: 'dist/jsonEditorWebview.js',
	logLevel: 'silent',
	plugins: [esbuildProblemMatcherPlugin],
};

async function main() {
	const contexts = await Promise.all(
		[extensionConfig, webviewConfig].map(config => esbuild.context(config))
	);
	if (watch) {
		await Promise.all(contexts.map(ctx => ctx.watch()));
	} else {
		await Promise.all(contexts.map(async ctx => {
			await ctx.rebuild();
			await ctx.dispose();
		}));
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
