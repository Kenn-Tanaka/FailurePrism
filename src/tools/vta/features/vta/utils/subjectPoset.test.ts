import { describe, it, expect } from 'vitest';
import { SubjectPoset } from './subjectPoset';

describe('SubjectPoset (主体包含半順序DAGエンジン)', () => {
  it('推移律 (Transitivity) に基づいて祖先・子孫関係を正しく判定できる', () => {
    const poset = new SubjectPoset();
    // A1 (機長A) -> A12 (A機クルー) -> A10 (海上保安庁)
    poset.addEdge('A1', 'A12');
    poset.addEdge('A12', 'A10');

    expect(poset.isAncestor('A12', 'A1')).toBe(true);
    expect(poset.isAncestor('A10', 'A1')).toBe(true); // 推移律
    expect(poset.isAncestor('A10', 'A12')).toBe(true);

    expect(poset.isDescendant('A1', 'A10')).toBe(true);
    expect(poset.isDescendant('A12', 'A10')).toBe(true);

    // 逆方向は false
    expect(poset.isAncestor('A1', 'A10')).toBe(false);
    expect(poset.isDescendant('A10', 'A1')).toBe(false);

    // 無関係な主体
    poset.addNode('B1');
    expect(poset.isAncestor('B1', 'A1')).toBe(false);
  });

  it('多重親 (DAG: 多重包含) を正しく表現し、双方の祖先をたどれる', () => {
    const poset = new SubjectPoset();
    // A1 は A12 (チーム) と A10 (組織) の両方に直接所属
    poset.addEdge('A1', 'A12', 'team');
    poset.addEdge('A1', 'A10', 'organizational');
    // A12 も A10 に所属
    poset.addEdge('A12', 'A10', 'organizational');

    const parents = poset.getImmediateParents('A1');
    expect(parents).toContain('A12');
    expect(parents).toContain('A10');

    const ancestors = poset.getAncestors('A1');
    expect(ancestors.has('A12')).toBe(true);
    expect(ancestors.has('A10')).toBe(true);
    expect(ancestors.size).toBe(2);
  });

  it('最小共通上位主体 (LCA: Lowest Common Ancestor) を正しく探索できる', () => {
    const poset = new SubjectPoset();
    // A1 (機長), A2 (副操縦士) -> A12 (クルー) -> A10 (海保)
    // C1 (タワー) -> C8 (羽田管制) -> CAB (航空局)
    poset.addEdge('A1', 'A12');
    poset.addEdge('A2', 'A12');
    poset.addEdge('A12', 'A10');

    poset.addEdge('C1', 'C8');
    poset.addEdge('C2', 'C8');
    poset.addEdge('C8', 'CAB');

    // 同一クルーの兄弟
    expect(poset.findLCA('A1', 'A2')).toBe('A12');
    // 親子関係
    expect(poset.findLCA('A1', 'A12')).toBe('A12');
    expect(poset.findLCA('A1', 'A10')).toBe('A10');
    // 無関係な組織間
    expect(poset.findLCA('A1', 'C1')).toBeUndefined();
  });

  it('循環参照 (サイクル) を検出し、決定論的に除去して DAG 化を保証する', () => {
    const poset = new SubjectPoset();
    poset.addNode('N1');
    poset.addNode('N2');
    poset.addNode('N3');

    // N1 -> N2 -> N3
    expect(poset.addEdge('N1', 'N2')).toBe(true);
    expect(poset.addEdge('N2', 'N3')).toBe(true);

    // N3 -> N1 を追加しようとすると直接 addEdge 側で弾かれる
    expect(poset.addEdge('N3', 'N1')).toBe(false);

    // シリアライズデータからサイクルが持ち込まれた場合の修復テスト
    const cycledPoset = new SubjectPoset();
    cycledPoset.addRawEdge('X', 'Y');
    cycledPoset.addRawEdge('Y', 'Z');
    cycledPoset.addRawEdge('Z', 'X'); // サイクルを直接注入

    const check = cycledPoset.validate();
    expect(check.valid).toBe(false);
    expect(check.cycles?.length).toBeGreaterThan(0);

    const { removedEdges } = cycledPoset.removeCycles();
    expect(removedEdges.length).toBeGreaterThan(0);
    expect(cycledPoset.validate().valid).toBe(true);
  });

  it('表記ゆれ・エイリアスおよび NFKC 正規化から正準IDを解決できる', () => {
    const poset = new SubjectPoset();
    poset.addNode('A10');
    poset.addAlias('海上保安庁', 'A10');
    poset.addAlias('海保', 'A10');
    poset.addAlias('ＪＡ７２２Ａ', 'A10'); // 全角

    expect(poset.resolveCanonical('A10')).toBe('A10');
    expect(poset.resolveCanonical('海上保安庁')).toBe('A10');
    expect(poset.resolveCanonical('海保')).toBe('A10');
    expect(poset.resolveCanonical('JA722A')).toBe('A10'); // 半角で検索しても一致

    // エイリアスを指定した包含クエリ
    poset.addEdge('A1', 'A10');
    expect(poset.isAncestor('海上保安庁', 'A1')).toBe(true);
  });

  it('VTAEntity 配列から正しく SubjectPoset を復元・シリアライズできる', () => {
    const entities = [
      { id: 'A1', name: '機長Ａ', parentEntityId: 'A12' },
      { id: 'A2', name: '副操縦員Ａ', parentEntityId: 'A12' },
      { id: 'A12', name: 'Ａ機運航クルー', parentEntityId: 'A10' },
      { id: 'A10', name: '海上保安庁' },
    ];

    const poset = SubjectPoset.fromEntities(entities);
    expect(poset.isAncestor('A10', 'A1')).toBe(true);
    expect(poset.isAncestor('A12', 'A2')).toBe(true);

    const json = poset.toJSON();
    expect(json.nodes).toContain('A1');
    expect(json.nodes).toContain('A10');
    expect(json.relations.length).toBe(3);

    const restored = SubjectPoset.fromData(json);
    expect(restored.isAncestor('A10', 'A1')).toBe(true);
  });
});
