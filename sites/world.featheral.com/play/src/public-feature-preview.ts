import { hash, terrainAt } from './engine.ts';
import { drawDiamond, drawHouse, drawTree, project, tileColor } from './map-art.ts';

export function drawPublicPreview(context: CanvasRenderingContext2D, kind: string): void {
  context.clearRect(0, 0, 720, 420);
  context.save();
  context.translate(360, 100);
  const seed = 20261108;
  for (let row = 0; row < 8; row++) for (let column = 0; column < 8; column++) {
    const point = project(column, row);
    const terrain = kind === 'settlements' ? (column === 0 || row === 7 ? 'river' : 'meadow') : terrainAt(column + 12, row + 8, seed);
    drawDiamond(context, point.x, point.y, tileColor(terrain, Math.floor(hash(column, row, seed) * 3), 'Summer'));
    if (kind === 'settlements' && column > 1 && column < 6 && row > 1 && row < 6 && (column + row) % 3 === 0) {
      drawHouse(context, point.x, point.y - 5, 1, { kind: column === 3 ? 'centre' : 'home', urban: false, night: false });
    } else if (terrain === 'forest' || terrain === 'rainforest' || terrain === 'pineforest' || kind === 'settlements' && row === 1 && column > 1) {
      drawTree(context, point.x, point.y, 35 + hash(row, column, seed) * 15, hash(column, row, seed), 'Summer');
    }
  }
  context.restore();
}
