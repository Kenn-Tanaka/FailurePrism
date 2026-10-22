import { describe, expect, it } from 'vitest';
import { calculateDraftEdgePath, calculateEdgePath, findConnectionTarget } from '../../../src/tools/tpdd/rendering/connectionPoints';

const source = { id: 'a', levelId: 'one', x: 0, y: 0, width: 180, height: 80 };
const target = { ...source, id: 'b', levelId: 'two', x: 320, y: 200 };

describe('辺中央への自動接続', () => {
  it('異なる列は左右中央を直線で結び、逆向きでも同じ端点を使う', () => {
    expect(calculateEdgePath(source, target)).toEqual({
      pathData: 'M 180 40 L 320 240', midPoint: { x: 250, y: 140 },
    });
    expect(calculateEdgePath(target, source).pathData).toBe('M 320 240 L 180 40');
  });

  it('同じ列は上下中央を使い、横ずれがあっても規則を維持する', () => {
    const sameColumn = { ...target, levelId: source.levelId };
    expect(calculateEdgePath(source, sameColumn).pathData).toBe('M 90 80 L 410 200');
    expect(calculateEdgePath(sameColumn, source).pathData).toBe('M 410 200 L 90 80');
  });

  it('分岐先の高さにかかわらず始点を共通にする', () => {
    for (const y of [-500, 0, 500]) {
      expect(calculateEdgePath(source, { ...target, y }).pathData).toBe(
        `M 180 40 L 320 ${y + 40}`
      );
    }
  });

  it('移動・サイズ変更後の実座標から接続側を再計算する', () => {
    expect(calculateEdgePath({ ...source, x: 700, width: 240 }, target).pathData)
      .toBe('M 700 40 L 500 240');
    const movedSource = { ...source, x: 50, y: 30 };
    const movedTarget = { ...target, x: 370, y: 230 };
    expect(calculateEdgePath(movedSource, movedTarget).pathData).toBe('M 230 70 L 370 270');
  });

  it.each([false, true])('双方向の曲線は分離し、主軸方向にノード間を進む（縦=%s）', (vertical) => {
    const end = vertical ? { ...target, levelId: source.levelId } : target;
    const forward = calculateEdgePath(source, end, true);
    const backward = calculateEdgePath(end, source, true);
    const axis = vertical ? 'y' : 'x';
    const cross = vertical ? 'x' : 'y';
    expect(forward.midPoint[axis]).toBe(backward.midPoint[axis]);
    expect(Math.abs(forward.midPoint[cross] - backward.midPoint[cross])).toBe(36);
    for (const [from, to] of [[source, end], [end, source]]) {
      const values = calculateEdgePath(from, to, true).pathData.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
      const index = vertical ? 1 : 0;
      const positions = [values[index], values[index + 2], values[index + 4], values[index + 6]];
      const direction = Math.sign(positions[3] - positions[0]);
      expect(positions.slice(1).every((value, i) => (value - positions[i]) * direction > 0)).toBe(true);
    }
  });

  it('重なり・同一中心・ゼロサイズでも有限座標を返す', () => {
    for (const end of [{ ...source, id: 'b' }, { ...target, x: 0, y: 0, width: 0, height: 0 }]) {
      for (const reverse of [false, true]) {
        const result = calculateEdgePath(source, end, reverse);
        expect(result.pathData).not.toMatch(/NaN|Infinity/);
        expect(Number.isFinite(result.midPoint.x + result.midPoint.y)).toBe(true);
      }
    }
  });

  it('自由ドラッグはカーソル方向の辺中央から開始する', () => {
    expect(calculateDraftEdgePath(source, { x: 400, y: 40 })).toBe('M 180 40 L 400 40');
    expect(calculateDraftEdgePath(source, { x: -100, y: 40 })).toBe('M 0 40 L -100 40');
    expect(calculateDraftEdgePath(source, { x: 90, y: 200 })).toBe('M 90 80 L 90 200');
    expect(calculateDraftEdgePath(source, { x: 90, y: -200 })).toBe('M 90 0 L 90 -200');
  });

  it('接続先に重なったプレビューは確定パスと一致する', () => {
    for (const end of [target, { ...target, levelId: source.levelId }]) {
      for (const reverse of [false, true]) {
        expect(calculateDraftEdgePath(source, { x: 330, y: 220 }, end, reverse))
          .toBe(calculateEdgePath(source, end, reverse).pathData);
      }
    }
  });

  it('接続先判定は自分を除外し、手前のノードを優先する', () => {
    const front = { ...target, id: 'front' };
    const nodes = [source, target, front];
    expect(findConnectionTarget(nodes, { x: 330, y: 220 }, source.id)).toBe(front);
    expect(findConnectionTarget(nodes, { x: 10, y: 10 }, source.id)).toBeUndefined();
    expect(findConnectionTarget(nodes, { x: 900, y: 900 }, source.id)).toBeUndefined();
    expect(nodes).toEqual([source, target, front]);
  });
});
