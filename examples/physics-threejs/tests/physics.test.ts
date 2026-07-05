import { describe, it, expect } from 'vitest';
import { World, Vec3, Sphere, Box, Particle, Spring } from '../src/physics';

describe('gravity integration', () => {
  it('accelerates a free body under gravity deterministically', () => {
    const w = new World({ gravity: new Vec3(0, -10, 0) });
    const s = w.add(new Sphere({ position: new Vec3(0, 100, 0), radius: 0.5, mass: 1 }));
    for (let i = 0; i < 100; i++) w.step(0.01); // 1s total
    expect(s.velocity.y).toBeCloseTo(-10, 1); // v = a*t, exact for equal Euler steps
    expect(s.position.y).toBeGreaterThan(94); // ~ fell 0.5*g*t^2 = 5
    expect(s.position.y).toBeLessThan(96);
    expect(Math.abs(s.position.x)).toBeLessThan(1e-9);
    expect(Math.abs(s.position.z)).toBeLessThan(1e-9);
  });

  it('is deterministic: identical runs produce identical state', () => {
    const run = () => {
      const w = new World({ gravity: new Vec3(0, -9.81, 0) });
      const a = w.add(new Sphere({ position: new Vec3(-1.5, 0, 0), velocity: new Vec3(2, 0, 0), radius: 0.5, mass: 1, restitution: 0.8 }));
      const b = w.add(new Sphere({ position: new Vec3(1.5, 0, 0), velocity: new Vec3(-2, 0, 0), radius: 0.5, mass: 1, restitution: 0.8 }));
      for (let i = 0; i < 300; i++) w.step(1 / 120);
      return [a.position.x, a.position.y, a.position.z, b.position.x, b.position.y, b.position.z];
    };
    expect(run()).toEqual(run());
  });
});

describe('sphere-sphere collision resolution', () => {
  it('elastic equal-mass head-on collision exchanges momentum (energy preserved)', () => {
    const w = new World({ gravity: new Vec3(0, 0, 0) });
    const a = w.add(new Sphere({ position: new Vec3(-2, 0, 0), velocity: new Vec3(1, 0, 0), radius: 1, mass: 1, restitution: 1 }));
    const b = w.add(new Sphere({ position: new Vec3(2, 0, 0), velocity: new Vec3(-1, 0, 0), radius: 1, mass: 1, restitution: 1 }));
    for (let i = 0; i < 400; i++) w.step(1 / 120);
    expect(a.velocity.x).toBeLessThan(-0.5); // bounced back
    expect(b.velocity.x).toBeGreaterThan(0.5);
    expect(a.velocity.x + b.velocity.x).toBeCloseTo(0, 1); // momentum conserved
    expect(Math.abs(a.velocity.x)).toBeCloseTo(1, 1); // energy conserved for e=1
    expect(Math.abs(b.velocity.x)).toBeCloseTo(1, 1);
    expect(b.position.x - a.position.x).toBeGreaterThan(2); // separated
  });

  it('perfectly inelastic collision (e=0) removes relative velocity', () => {
    const w = new World({ gravity: new Vec3(0, 0, 0) });
    const a = w.add(new Sphere({ position: new Vec3(-2, 0, 0), velocity: new Vec3(1, 0, 0), radius: 1, mass: 1, restitution: 0 }));
    const b = w.add(new Sphere({ position: new Vec3(2, 0, 0), velocity: new Vec3(-1, 0, 0), radius: 1, mass: 1, restitution: 0 }));
    for (let i = 0; i < 400; i++) w.step(1 / 120);
    expect(Math.abs(a.velocity.x)).toBeLessThan(0.2);
    expect(Math.abs(b.velocity.x)).toBeLessThan(0.2);
  });

  it('lower restitution dissipates more kinetic energy', () => {
    const sim = (e: number) => {
      const w = new World({ gravity: new Vec3(0, 0, 0) });
      const a = w.add(new Sphere({ position: new Vec3(-2, 0, 0), velocity: new Vec3(3, 0, 0), radius: 1, mass: 1, restitution: e }));
      const b = w.add(new Sphere({ position: new Vec3(2, 0, 0), velocity: new Vec3(-3, 0, 0), radius: 1, mass: 1, restitution: e }));
      for (let i = 0; i < 400; i++) w.step(1 / 240);
      return 0.5 * (a.velocity.x ** 2 + a.velocity.y ** 2 + b.velocity.x ** 2 + b.velocity.y ** 2);
    };
    const elastic = sim(1);
    const damped = sim(0.2);
    expect(elastic).toBeGreaterThan(8); // initial KE per side ~9, elastic keeps it
    expect(damped).toBeLessThan(elastic); // restitution < 1 loses energy
  });
});

describe('box stacking / collision resolution', () => {
  it('a falling box rests on a static ground box instead of passing through', () => {
    const w = new World({ gravity: new Vec3(0, -10, 0) });
    const ground = w.add(new Box({ position: new Vec3(0, 0, 0), halfExtents: new Vec3(10, 1, 10), mass: 0 }));
    const box = w.add(new Box({ position: new Vec3(0, 5, 0), halfExtents: new Vec3(0.5, 0.5, 0.5), mass: 1, restitution: 0 }));
    for (let i = 0; i < 600; i++) w.step(1 / 120);
    expect(box.position.y).toBeGreaterThan(1.3); // ground top y=1 + box half 0.5 => ~1.5
    expect(box.position.y).toBeLessThan(1.9);
    expect(Math.abs(box.velocity.y)).toBeLessThan(0.5); // at rest
    expect(ground.position.y).toBeCloseTo(0, 6); // static ground fixed
  });
});

describe('spring / constraint solving', () => {
  it('a damped spring pulls a particle to its rest length and holds a pinned anchor', () => {
    const w = new World({ gravity: new Vec3(0, 0, 0) });
    const anchor = w.add(new Particle({ position: new Vec3(0, 0, 0), mass: 1, pinned: true }));
    const p = w.add(new Particle({ position: new Vec3(5, 0, 0), mass: 1 }));
    w.addSpring(new Spring(anchor, p, { restLength: 1, stiffness: 100, damping: 30 }));
    for (let i = 0; i < 5000; i++) w.step(1 / 240);
    expect(anchor.position.x).toBeCloseTo(0, 6); // pinned never moves
    expect(anchor.position.y).toBeCloseTo(0, 6);
    const dx = p.position.x - anchor.position.x;
    const dy = p.position.y - anchor.position.y;
    const dz = p.position.z - anchor.position.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(dist).toBeCloseTo(1, 1); // settles at rest length
  });
});
