import { furnitureParts } from './house-view.mjs';

// Furniture's broadest horizontal part is its supporting surface.
export function furniturePose(data, actor) {
  if (!['sit', 'lie'].includes(actor.pose)) return null;
  const item = data.items.find((it) => it.id === actor.furnitureId);
  if (!item) return null;
  const parts = furnitureParts({ defs: data.defs, items: [item] });
  const surface = parts.reduce((best, p) => !best || p.w * p.d > best.w * best.d ? p : best, null);
  if (!surface) return null;
  return { x: surface.x + surface.w / 2, z: surface.z + surface.d / 2,
    y: surface.y + surface.h, angle: -item.rot * Math.PI / 2, pose: actor.pose };
}
