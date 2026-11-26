// Package only the standalone bundles. Installation from this tarball needs no registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require('../package.json');
const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'taskhub-cli-package-'));
try {
    const bundles = ['cli', 'actionsValidator'];
    fs.mkdirSync(path.join(stage, 'dist'));
    fs.mkdirSync(path.join(stage, 'bin'));
    fs.copyFileSync(path.join(root, 'bin', 'taskhub.cjs'), path.join(stage, 'bin', 'taskhub.cjs'));
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
    const packages = new Set();
    for (const name of bundles) {
        fs.copyFileSync(path.join(dist, name + '.js'), path.join(stage, 'dist', name + '.js'));
        const meta = require(path.join(root, 'out', 'build', name + '.meta.json'));
        for (const input of Object.keys(meta.inputs)) {
            const match = /^(.*node_modules\/((?:@[^/]+\/)?[^/]+))\//.exec(input);
            if (match) { packages.add(match[1]); }
        }
    }
    const notices = Array.from(packages).sort().map(location => {
        const folder = path.join(root, location);
        const license = fs.readdirSync(folder).find(name => /^licen[sc]e(?:\.\w+)?$/i.test(name));
        if (!license) { throw new Error('Missing bundled license in ' + location); }
        const { name, version } = require(path.join(folder, 'package.json'));
        return name + ' ' + version + '\n' + fs.readFileSync(path.join(folder, license), 'utf8');
    });
    fs.writeFileSync(path.join(stage, 'THIRD-PARTY-NOTICES.txt'), notices.join('\n\n'));
    const features = fs.readFileSync(path.join(root, 'docs', 'features.md'), 'utf8');
    const guide = features.match(/^## Standalone CLI\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
    if (!guide) { throw new Error('Missing Standalone CLI usage guide'); }
    fs.writeFileSync(path.join(stage, 'README.md'), '# TaskHub CLI\n' + guide[1]);
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
        name: 'taskhub-cli', version: pkg.version, description: 'TaskHub standalone CLI and stdio MCP server',
        license: pkg.license, repository: pkg.repository, bin: { taskhub: 'bin/taskhub.cjs' }, engines: { node: '>=22' },
    }, null, 2) + '\n');
    execFileSync(process.execPath, [process.env.npm_execpath, 'pack', '--offline', '--ignore-scripts', '--pack-destination', dist],
        { cwd: stage, stdio: 'inherit' });
} finally {
    fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5 });
}
