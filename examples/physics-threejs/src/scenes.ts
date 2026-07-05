import { World, Vec3, Sphere, Box, Particle, Spring } from './physics';

export function createSpheresScene(): World {
  const world = new World({ gravity: new Vec3(0, -9.81, 0) });

  for (let i = 0; i < 5; i++) {
    const x = -2 + i * 1;
    const y = 10 + i * 2;
    const sphere = new Sphere({
      position: new Vec3(x, y, 0),
      velocity: new Vec3(Math.random() * 2 - 1, 0, 0),
      radius: 0.5,
      mass: 1,
      restitution: 0.8,
    });
    world.add(sphere);
  }

  const ground = new Box({
    position: new Vec3(0, -2, 0),
    halfExtents: new Vec3(10, 1, 10),
    mass: 0,
    restitution: 0.5,
  });
  world.add(ground);

  return world;
}

export function createBoxStackScene(): World {
  const world = new World({ gravity: new Vec3(0, -9.81, 0) });

  const ground = new Box({
    position: new Vec3(0, 0, 0),
    halfExtents: new Vec3(10, 1, 10),
    mass: 0,
    restitution: 0.3,
  });
  world.add(ground);

  const boxSize = 0.5;
  for (let layer = 0; layer < 3; layer++) {
    for (let col = 0; col < 4 - layer; col++) {
      const x = -1.5 + layer * 0.25 + col * (boxSize * 2 + 0.05);
      const y = 1.5 + layer * (boxSize * 2 + 0.1);
      const box = new Box({
        position: new Vec3(x, y, 0),
        halfExtents: new Vec3(boxSize, boxSize, boxSize),
        mass: 1,
        restitution: 0.3,
      });
      world.add(box);
    }
  }

  return world;
}

export function createClothScene(): World {
  const world = new World({ gravity: new Vec3(0, -9.81, 0) });

  const clothWidth = 8;
  const clothHeight = 6;
  const segmentsX = 6;
  const segmentsY = 5;
  const spacing = clothWidth / segmentsX;

  const particles: Particle[] = [];

  for (let y = 0; y <= segmentsY; y++) {
    for (let x = 0; x <= segmentsX; x++) {
      const px = -clothWidth / 2 + x * spacing;
      const py = 5 + clothHeight - (y * spacing);
      const particle = new Particle({
        position: new Vec3(px, py, 0),
        mass: 1,
        pinned: y === 0 && (x === 0 || x === segmentsX),
      });
      world.add(particle);
      particles.push(particle);
    }
  }

  for (let y = 0; y <= segmentsY; y++) {
    for (let x = 0; x <= segmentsX; x++) {
      const idx = y * (segmentsX + 1) + x;

      if (x < segmentsX) {
        const right = idx + 1;
        world.addSpring(
          new Spring(particles[idx], particles[right], {
            restLength: spacing,
            stiffness: 500,
            damping: 15,
          })
        );
      }

      if (y < segmentsY) {
        const below = idx + (segmentsX + 1);
        world.addSpring(
          new Spring(particles[idx], particles[below], {
            restLength: spacing,
            stiffness: 500,
            damping: 15,
          })
        );
      }
    }
  }

  const ground = new Box({
    position: new Vec3(0, -1, 0),
    halfExtents: new Vec3(20, 0.5, 10),
    mass: 0,
    restitution: 0.5,
  });
  world.add(ground);

  return world;
}
