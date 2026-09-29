import * as assert from 'assert';
import { createRequest } from '../jenkins/model';
import { JenkinsRequest } from '../jenkins/types';
import { JenkinsTreeNode, JenkinsViewProvider } from '../providers/jenkinsViewProvider';

suite('Jenkins 트리 펼침 상태 식별자', () => {
    function request(id: string, repoPath = '/repo', branch = 'main'): JenkinsRequest {
        const value = createRequest({ id, repoPath, branch, sha: 'a'.repeat(40),
            root: { serverId: 'ci', jobUrl: 'https://ci.example/job/build/' } });
        value.runs = [{ serverId: 'ci', jobUrl: value.root.jobUrl, url: 'https://ci.example/job/build/1/', number: 1, building: true, result: null }];
        return value;
    }

    function expandable(provider: JenkinsViewProvider, parent?: JenkinsTreeNode): JenkinsTreeNode[] {
        return provider.getChildren(parent).filter(node => node.kind !== 'detail')
            .flatMap(node => [node, ...expandable(provider, node)]);
    }

    test('새 객체로 갱신하고 상태·표시명이 바뀌어도 같은 노드의 ID를 유지한다', () => {
        let requests = [request('first')];
        const provider = new JenkinsViewProvider(() => requests, () => []);
        try {
            const before = expandable(provider).map(node => provider.getTreeItem(node));
            requests = structuredClone(requests);
            requests[0].runs[0].building = false;
            requests[0].runs[0].result = 'FAILURE';
            requests[0].runs[0].fullDisplayName = 'renamed #1';
            provider.refresh();
            const after = expandable(provider).map(node => provider.getTreeItem(node));
            assert.strictEqual(before.length, 4);
            assert.ok(before.every(item => !!item.id));
            assert.deepStrictEqual(after.map(item => item.id), before.map(item => item.id));
            assert.notDeepStrictEqual(after.map(item => item.label), before.map(item => item.label));
        } finally { provider.dispose(); }
    });

    test('동일 SHA·브랜치·빌드라도 저장소와 요청이 다르면 ID가 충돌하지 않는다', () => {
        const requests = [request('one'), request('two'), request('three', '/another'), request('four', '/repo', 'feature')];
        const provider = new JenkinsViewProvider(() => requests, () => []);
        try {
            const ids = expandable(provider).map(node => provider.getTreeItem(node).id);
            assert.ok(ids.every(id => !!id));
            assert.strictEqual(new Set(ids).size, ids.length);
        } finally { provider.dispose(); }
    });
});
