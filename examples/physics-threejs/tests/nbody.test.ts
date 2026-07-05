import { describe, it, expect, vi } from 'vitest';
import { World, Vec3, Sphere } from '../src/physics';
import * as scenes from '../src/scenes';

// Measure each body's instantaneous acceleration via the velocity change over one
// tiny step. Integrator-agnostic (semi-implicit Euler / leapfrog): for the first
// step from the given positions, dv/dt == a to O(dt). Bodies start at rest.
function accels(world: any, dt = 1e-5): Vec3[] {
  const v0 = world.bodies.map((b: any) => b.velocity.copy());
  world.step(dt);
  return world.bodies.map((b: any, i: number) =>
    new Vec3((b.velocity.x - v0[i].x) / dt, (b.velocity.y - v0[i].y) / dt, (b.velocity.z - v0[i].z) / dt)
  );
}

// Enable the N-body gravitational attraction mode with gravitational constant G.
const nbody = (G: number) => new World({ nbody: true, G } as any);

describe('N-body gravitational mode: force law', () => {
  it('inverse-square magnitude and direction between two point masses', () => {
    const w = nbody(1);
    w.add(new Sphere({ position: new Vec3(0, 0, 0), radius: 0.1, mass: 2 }));
    w.add(new Sphere({ position: new Vec3(4, 0, 0), radius: 0.1, mass: 3 }));
    const [aa, ab] = accels(w);
    // |a_A| = G*m_B/r^2 = 3/16 = 0.1875 toward +x; |a_B| = G*m_A/r^2 = 2/16 = 0.125 toward -x
    expect(aa.x).toBeCloseTo(0.1875, 4);
    expect(Math.abs(aa.y)).toBeLessThan(1e-6);
    expect(Math.abs(aa.z)).toBeLessThan(1e-6);
    expect(ab.x).toBeCloseTo(-0.125, 4);
  });

  it('is symmetric: equal masses feel equal-and-opposite accelerations (Newton III)', () => {
    const w = nbody(1);
    w.add(new Sphere({ position: new Vec3(-2, 0, 0), radius: 0.1, mass: 1 }));
    w.add(new Sphere({ position: new Vec3(2, 0, 0), radius: 0.1, mass: 1 }));
    const [aa, ab] = accels(w);
    expect(aa.x).toBeCloseTo(1 / 16, 4);   // pulled toward +x partner
    expect(ab.x).toBeCloseTo(-1 / 16, 4);  // pulled toward -x partner
    expect(aa.x).toBeCloseTo(-ab.x, 6);
  });

  it('net internal force is zero: sum of mass*acceleration ~ 0 for an arbitrary config', () => {
    const w = nbody(1);
    const bodies = [
      w.add(new Sphere({ position: new Vec3(1, 0.5, 0), radius: 0.1, mass: 1 })),
      w.add(new Sphere({ position: new Vec3(-1.3, 0.7, 0.2), radius: 0.1, mass: 2 })),
      w.add(new Sphere({ position: new Vec3(0.2, -1.1, -0.4), radius: 0.1, mass: 3 })),
    ];
    const a = accels(w);
    let sx = 0, sy = 0, sz = 0;
    a.forEach((ai, i) => { sx += bodies[i].mass * ai.x; sy += bodies[i].mass * ai.y; sz += bodies[i].mass * ai.z; });
    expect(sx).toBeCloseTo(0, 4);
    expect(sy).toBeCloseTo(0, 4);
    expect(sz).toBeCloseTo(0, 4);
  });

  it('symmetric equilateral triangle: each body pulled toward the centroid, equal magnitudes', () => {
    const w = nbody(1);
    const R = 2;
    const P = [0, 2 * Math.PI / 3, 4 * Math.PI / 3].map(
      (th) => new Vec3(R * Math.cos(th), R * Math.sin(th), 0)
    );
    P.forEach((p) => w.add(new Sphere({ position: p, radius: 0.1, mass: 1 })));
    const a = accels(w);
    const mags = a.map((ai) => ai.length());
    expect(mags[1]).toBeCloseTo(mags[0], 4); // equal by symmetry
    expect(mags[2]).toBeCloseTo(mags[0], 4);
    a.forEach((ai, i) => {
      // points inward toward origin (= centroid): a . (-p) > 0
      const inward = -(ai.x * P[i].x + ai.y * P[i].y + ai.z * P[i].z);
      expect(inward).toBeGreaterThan(0);
    });
  });

  it('no floor / no downward gravity: a lone body coasts in a straight line', () => {
    const w = nbody(1);
    const s = w.add(new Sphere({ position: new Vec3(0, 5, 0), velocity: new Vec3(1, 0, 0), radius: 0.1, mass: 1 }));
    for (let i = 0; i < 100; i++) w.step(0.01);
    expect(s.position.x).toBeGreaterThan(0.5); // moved along its velocity
    expect(s.position.y).toBeCloseTo(5, 3);    // never fell
    expect(Math.abs(s.velocity.y)).toBeLessThan(1e-6);
  });
});

describe('N-body integrator stability (stable configuration stays bounded)', () => {
  it('equal-mass circular triangle orbit remains bounded over many steps', () => {
    const w = nbody(1);
    const R = 3, m = 1;
    // circular speed for a 3-mass ring: v = sqrt(G*m / (sqrt(3)*R))
    const v = Math.sqrt((1 * m) / (Math.sqrt(3) * R));
    const bodies = [0, 2 * Math.PI / 3, 4 * Math.PI / 3].map((th) => {
      const p = new Vec3(R * Math.cos(th), R * Math.sin(th), 0);
      const vel = new Vec3(-v * Math.sin(th), v * Math.cos(th), 0); // tangential
      return w.add(new Sphere({ position: p, velocity: vel, radius: 0.1, mass: m }));
    });
    const start = bodies.map((b) => b.position.copy());
    for (let i = 0; i < 4000; i++) {
      w.step(0.005);
      for (const b of bodies) {
        const d = b.position.length();
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThan(1); // did not spiral into a singularity
        expect(d).toBeLessThan(6);    // did not blow up / fly apart
      }
    }
    let moved = 0;
    bodies.forEach((b, i) => { moved += Vec3.sub(b.position, start[i]).length(); });
    expect(moved).toBeGreaterThan(1); // it actually orbited, not frozen
  });
});

describe('fourth scene is driven by the real engine (anti-reimplementation)', () => {
  it('createThreeBodyScene builds an N-body World advanced through World.step', () => {
    const make = (scenes as any).createThreeBodyScene;
    expect(typeof make, 'createThreeBodyScene must be exported from src/scenes').toBe('function');
    const stepSpy = vi.spyOn(World.prototype, 'step');
    const w = make();
    expect(w, 'factory must return a physics World').toBeInstanceOf(World);
    const massive = w.bodies.filter((b: any) => b.mass > 0);
    expect(massive.length, 'the three-body scene has exactly 3 orbiting bodies').toBe(3);
    const before = w.bodies.map((b: any) => b.position.copy());
    const callsBefore = stepSpy.mock.calls.length;
    for (let i = 0; i < 300; i++) w.step(1 / 60);
    expect(stepSpy.mock.calls.length - callsBefore, 'scene must advance via the real World.step').toBeGreaterThanOrEqual(300);
    let maxR = 0, moved = 0;
    w.bodies.forEach((b: any, i: number) => {
      maxR = Math.max(maxR, b.position.length());
      moved += Vec3.sub(b.position, before[i]).length();
      expect(Number.isFinite(b.position.x + b.position.y + b.position.z)).toBe(true);
    });
    expect(moved, 'bodies must actually orbit').toBeGreaterThan(0.1);
    expect(maxR, 'a stable orbit must stay bounded').toBeLessThan(100);
    stepSpy.mockRestore();
  });

  it('the scene uses gravitational attraction, not downward gravity', () => {
    const make = (scenes as any).createThreeBodyScene;
    const w = make();
    const dt = 1e-5;
    const v0 = w.bodies.map((b: any) => b.velocity.copy());
    w.step(dt);
    let sx = 0, sy = 0, maxA = 0;
    w.bodies.forEach((b: any, i: number) => {
      const ax = (b.velocity.x - v0[i].x) / dt;
      const ay = (b.velocity.y - v0[i].y) / dt;
      sx += b.mass * ax; sy += b.mass * ay;
      maxA = Math.max(maxA, Math.hypot(ax, ay));
    });
    expect(maxA, 'gravitational attraction must produce acceleration').toBeGreaterThan(1e-3);
    expect(Math.abs(sx), 'no net external force in x').toBeLessThan(1e-2);
    expect(Math.abs(sy), 'no net downward gravity (internal forces sum to ~0)').toBeLessThan(1e-2);
  });
});
