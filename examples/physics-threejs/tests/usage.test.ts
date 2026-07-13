import { describe, it, expect, vi } from 'vitest';
import { World } from '../src/physics';
import * as scenes from '../src/scenes';

// Anti-reimplementation gate: the demo's scenes must be built on and advanced by
// the real engine (World.step), not a parallel physics reimplementation.
function snapshot(w: any): number[] {
  const out: number[] = [];
  for (const b of w.bodies) out.push(b.position.x, b.position.y, b.position.z);
  return out;
}

describe('demo scenes are driven by the real physics engine (anti-reimplementation)', () => {
  it('each showcased simulation builds a real World and advances through World.step', () => {
    const stepSpy = vi.spyOn(World.prototype, 'step');
    const factories: Array<[string, any]> = [
      ['bouncing spheres', (scenes as any).createSpheresScene],
      ['box stack', (scenes as any).createBoxStackScene],
      ['cloth/chain', (scenes as any).createClothScene],
    ];
    let total = 0;
    for (const [name, make] of factories) {
      expect(typeof make, name + ': scene factory must be exported from src/scenes').toBe('function');
      const w = make();
      expect(w, name + ': factory must return a physics World').toBeInstanceOf(World);
      expect(Array.isArray(w.bodies) && w.bodies.length > 0, name + ': World must contain bodies').toBe(true);
      const before = snapshot(w);
      const callsBefore = stepSpy.mock.calls.length;
      for (let i = 0; i < 180; i++) w.step(1 / 60);
      expect(stepSpy.mock.calls.length - callsBefore, name + ': must advance via the real World.step').toBeGreaterThanOrEqual(180);
      const after = snapshot(w);
      expect(after, name + ': simulation state must visibly change when stepped').not.toEqual(before);
      total += w.bodies.length;
    }
    expect(stepSpy).toHaveBeenCalled();
    expect(total).toBeGreaterThan(0);
    stepSpy.mockRestore();
  });
});
