const path = require('node:path');

// 실행 위치는 확인하되 사용자 이름이 포함된 절대 경로는 출력하지 않습니다.
const cwd = path.resolve(process.cwd()) === path.resolve(__dirname)
    ? '<workspace>/examples/command_shell'
    : '<outside-example>';

console.log(JSON.stringify({
    argv: process.argv.slice(2),
    cwd,
    env: { TASKHUB_DEMO: process.env.TASKHUB_DEMO ?? null },
}, null, 4));
