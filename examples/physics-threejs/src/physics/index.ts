export class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  copy(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  add(v: Vec3): Vec3 {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  sub(v: Vec3): Vec3 {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s: number): Vec3 {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  length(): number {
    return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
  }

  normalize(): Vec3 {
    const len = this.length();
    if (len > 0) {
      this.x /= len;
      this.y /= len;
      this.z /= len;
    }
    return this;
  }

  static sub(a: Vec3, b: Vec3): Vec3 {
    return new Vec3(a.x - b.x, a.y - b.y, a.z - b.z);
  }

  static add(a: Vec3, b: Vec3): Vec3 {
    return new Vec3(a.x + b.x, a.y + b.y, a.z + b.z);
  }

  static scale(v: Vec3, s: number): Vec3 {
    return new Vec3(v.x * s, v.y * s, v.z * s);
  }
}

export interface SphereConfig {
  position: Vec3;
  velocity?: Vec3;
  radius: number;
  mass?: number;
  restitution?: number;
}

export interface BoxConfig {
  position: Vec3;
  halfExtents: Vec3;
  velocity?: Vec3;
  mass?: number;
  restitution?: number;
}

export interface ParticleConfig {
  position: Vec3;
  mass?: number;
  pinned?: boolean;
}

export interface SpringConfig {
  restLength: number;
  stiffness: number;
  damping?: number;
}

export class Sphere {
  position: Vec3;
  velocity: Vec3;
  radius: number;
  mass: number;
  restitution: number;
  acceleration: Vec3 = new Vec3(0, 0, 0);

  constructor(config: SphereConfig) {
    this.position = config.position.copy();
    this.velocity = config.velocity ? config.velocity.copy() : new Vec3(0, 0, 0);
    this.radius = config.radius;
    this.mass = config.mass ?? 1;
    this.restitution = config.restitution ?? 0.8;
  }
}

export class Box {
  position: Vec3;
  velocity: Vec3;
  halfExtents: Vec3;
  mass: number;
  restitution: number;
  acceleration: Vec3 = new Vec3(0, 0, 0);

  constructor(config: BoxConfig) {
    this.position = config.position.copy();
    this.velocity = config.velocity ? config.velocity.copy() : new Vec3(0, 0, 0);
    this.halfExtents = config.halfExtents.copy();
    this.mass = config.mass ?? 1;
    this.restitution = config.restitution ?? 0.8;
  }
}

export class Particle {
  position: Vec3;
  velocity: Vec3;
  mass: number;
  pinned: boolean;
  acceleration: Vec3 = new Vec3(0, 0, 0);

  constructor(config: ParticleConfig) {
    this.position = config.position.copy();
    this.velocity = new Vec3(0, 0, 0);
    this.mass = config.mass ?? 1;
    this.pinned = config.pinned ?? false;
  }
}

export class Spring {
  a: any;
  b: any;
  restLength: number;
  stiffness: number;
  damping: number;

  constructor(a: any, b: any, config: SpringConfig) {
    this.a = a;
    this.b = b;
    this.restLength = config.restLength;
    this.stiffness = config.stiffness;
    this.damping = config.damping ?? 0;
  }
}

export class World {
  gravity: Vec3;
  bodies: (Sphere | Box | Particle)[] = [];
  springs: Spring[] = [];

  constructor(config?: { gravity?: Vec3 }) {
    this.gravity = config?.gravity ? config.gravity.copy() : new Vec3(0, -9.81, 0);
  }

  add(body: Sphere | Box | Particle): Sphere | Box | Particle {
    this.bodies.push(body);
    return body;
  }

  addSpring(spring: Spring): void {
    this.springs.push(spring);
  }

  step(dt: number): void {
    this.applyForces();
    this.solveSprings(dt);
    this.integrate(dt);
    this.detectAndResolveCollisions(dt);
  }

  private applyForces(): void {
    for (const body of this.bodies) {
      if (body.mass === 0) continue;
      body.acceleration = this.gravity.copy();
    }
  }

  private integrate(dt: number): void {
    for (const body of this.bodies) {
      if (body.mass === 0) continue;

      if (!(body instanceof Particle) || !body.pinned) {
        body.velocity.add(Vec3.scale(body.acceleration, dt));
        body.position.add(Vec3.scale(body.velocity, dt));
      }
    }
  }

  private solveSprings(dt: number): void {
    for (const spring of this.springs) {
      const a = spring.a;
      const b = spring.b;

      const delta = Vec3.sub(b.position, a.position);
      const dist = delta.length();

      if (dist > 1e-6) {
        const direction = delta.copy().normalize();

        const relVel = Vec3.sub(b.velocity, a.velocity);
        const relVelAlongSpring = relVel.dot(direction);

        const springForce = (dist - spring.restLength) * spring.stiffness;
        const dampingForce = relVelAlongSpring * spring.damping;
        const totalForce = springForce + dampingForce;

        if (a.mass > 0 && !(a instanceof Particle && a.pinned)) {
          const accel = totalForce / a.mass;
          a.acceleration.add(Vec3.scale(direction, accel));
        }

        if (b.mass > 0 && !(b instanceof Particle && b.pinned)) {
          const accel = totalForce / b.mass;
          b.acceleration.add(Vec3.scale(direction, -accel));
        }
      }
    }
  }

  private detectAndResolveCollisions(dt: number): void {
    for (let i = 0; i < this.bodies.length; i++) {
      for (let j = i + 1; j < this.bodies.length; j++) {
        const a = this.bodies[i];
        const b = this.bodies[j];

        if (a instanceof Sphere && b instanceof Sphere) {
          this.collideSphereSphere(a, b);
        } else if (a instanceof Box && b instanceof Box) {
          this.collideBoxBox(a, b);
        } else if (a instanceof Box && b instanceof Sphere) {
          this.collideBoxSphere(a, b);
        } else if (a instanceof Sphere && b instanceof Box) {
          this.collideBoxSphere(b, a);
        } else if (a instanceof Box && b instanceof Particle) {
          this.collideBoxParticle(a, b);
        } else if (a instanceof Particle && b instanceof Box) {
          this.collideBoxParticle(b, a);
        }
      }
    }
  }

  private collideSphereSphere(a: Sphere, b: Sphere): void {
    const delta = Vec3.sub(b.position, a.position);
    const dist = delta.length();
    const minDist = a.radius + b.radius;

    if (dist < minDist) {
      let normal = delta.copy();
      if (dist < 1e-6) {
        normal.x = 1;
        normal.y = 0;
        normal.z = 0;
      } else {
        normal.normalize();
      }

      const overlap = minDist - dist;
      const correction = overlap + 0.001;

      if (a.mass > 0 && b.mass > 0) {
        a.position.add(Vec3.scale(normal, -correction / 2));
        b.position.add(Vec3.scale(normal, correction / 2));
      } else if (a.mass > 0) {
        a.position.add(Vec3.scale(normal, -correction));
      } else if (b.mass > 0) {
        b.position.add(Vec3.scale(normal, correction));
      }

      const relVel = Vec3.sub(a.velocity, b.velocity);
      const velAlongNormal = relVel.dot(normal);

      if (velAlongNormal > 0) {
        const e = Math.min(a.restitution, b.restitution);
        const aStatic = a.mass === 0;
        const bStatic = b.mass === 0;

        if (!aStatic && !bStatic) {
          const invMassSum = 1 / a.mass + 1 / b.mass;
          const impulseMag = -(1 + e) * velAlongNormal / invMassSum;
          a.velocity.add(Vec3.scale(normal, impulseMag / a.mass));
          b.velocity.add(Vec3.scale(normal, -impulseMag / b.mass));
        } else if (!aStatic && bStatic) {
          a.velocity.add(Vec3.scale(normal, -(1 + e) * velAlongNormal));
        } else if (aStatic && !bStatic) {
          b.velocity.add(Vec3.scale(normal, (1 + e) * velAlongNormal));
        }
      }
    }
  }

  private collideBoxBox(a: Box, b: Box): void {
    const minA = new Vec3(
      a.position.x - a.halfExtents.x,
      a.position.y - a.halfExtents.y,
      a.position.z - a.halfExtents.z
    );
    const maxA = new Vec3(
      a.position.x + a.halfExtents.x,
      a.position.y + a.halfExtents.y,
      a.position.z + a.halfExtents.z
    );

    const minB = new Vec3(
      b.position.x - b.halfExtents.x,
      b.position.y - b.halfExtents.y,
      b.position.z - b.halfExtents.z
    );
    const maxB = new Vec3(
      b.position.x + b.halfExtents.x,
      b.position.y + b.halfExtents.y,
      b.position.z + b.halfExtents.z
    );

    if (
      maxA.x < minB.x || minA.x > maxB.x ||
      maxA.y < minB.y || minA.y > maxB.y ||
      maxA.z < minB.z || minA.z > maxB.z
    ) {
      return;
    }

    const overlapX = Math.min(maxA.x, maxB.x) - Math.max(minA.x, minB.x);
    const overlapY = Math.min(maxA.y, maxB.y) - Math.max(minA.y, minB.y);
    const overlapZ = Math.min(maxA.z, maxB.z) - Math.max(minA.z, minB.z);

    let normal = new Vec3(0, 0, 0);
    let depth = 0;

    if (overlapX < overlapY && overlapX < overlapZ) {
      depth = overlapX;
      if (a.position.x < b.position.x) {
        normal = new Vec3(1, 0, 0);
      } else {
        normal = new Vec3(-1, 0, 0);
      }
    } else if (overlapY < overlapZ) {
      depth = overlapY;
      if (a.position.y < b.position.y) {
        normal = new Vec3(0, 1, 0);
      } else {
        normal = new Vec3(0, -1, 0);
      }
    } else {
      depth = overlapZ;
      if (a.position.z < b.position.z) {
        normal = new Vec3(0, 0, 1);
      } else {
        normal = new Vec3(0, 0, -1);
      }
    }

    const correction = depth + 0.001;

    const aStatic = a.mass === 0;
    const bStatic = b.mass === 0;

    if (aStatic && bStatic) {
      // Both static, no separation needed
    } else if (!aStatic && !bStatic) {
      a.position.add(Vec3.scale(normal, -correction / 2));
      b.position.add(Vec3.scale(normal, correction / 2));
    } else if (!aStatic && bStatic) {
      a.position.add(Vec3.scale(normal, -correction));
    } else if (aStatic && !bStatic) {
      b.position.add(Vec3.scale(normal, correction));
    }

    const relVel = Vec3.sub(a.velocity, b.velocity);
    const velAlongNormal = relVel.dot(normal);

    if (velAlongNormal > 0) {
      const e = Math.min(a.restitution, b.restitution);

      if (!aStatic && !bStatic) {
        const invMassSum = 1 / a.mass + 1 / b.mass;
        const impulseMag = -(1 + e) * velAlongNormal / invMassSum;
        a.velocity.add(Vec3.scale(normal, impulseMag / a.mass));
        b.velocity.add(Vec3.scale(normal, -impulseMag / b.mass));
      } else if (!aStatic && bStatic) {
        a.velocity.add(Vec3.scale(normal, -(1 + e) * velAlongNormal));
      } else if (aStatic && !bStatic) {
        b.velocity.add(Vec3.scale(normal, (1 + e) * velAlongNormal));
      }
    }
  }

  private collideBoxSphere(box: Box, sphere: Sphere): void {
    const closestPoint = new Vec3(
      Math.max(box.position.x - box.halfExtents.x, Math.min(sphere.position.x, box.position.x + box.halfExtents.x)),
      Math.max(box.position.y - box.halfExtents.y, Math.min(sphere.position.y, box.position.y + box.halfExtents.y)),
      Math.max(box.position.z - box.halfExtents.z, Math.min(sphere.position.z, box.position.z + box.halfExtents.z))
    );

    const delta = Vec3.sub(sphere.position, closestPoint);
    const dist = delta.length();

    if (dist < sphere.radius) {
      let normal = delta.copy();
      if (dist < 1e-6) {
        normal.x = 0;
        normal.y = 1;
        normal.z = 0;
      } else {
        normal.normalize();
      }

      const overlap = sphere.radius - dist;
      const correction = overlap + 0.001;

      if (sphere.mass > 0 && box.mass > 0) {
        sphere.position.add(Vec3.scale(normal, correction / 2));
        box.position.add(Vec3.scale(normal, -correction / 2));
      } else if (sphere.mass > 0) {
        sphere.position.add(Vec3.scale(normal, correction));
      } else if (box.mass > 0) {
        box.position.add(Vec3.scale(normal, -correction));
      }

      const relVel = Vec3.sub(sphere.velocity, box.velocity);
      const velAlongNormal = relVel.dot(normal);

      if (velAlongNormal > 0) {
        const e = Math.min(box.restitution, sphere.restitution);
        const sphereStatic = sphere.mass === 0;
        const boxStatic = box.mass === 0;

        if (!sphereStatic && !boxStatic) {
          const invMassSum = 1 / sphere.mass + 1 / box.mass;
          const impulseMag = -(1 + e) * velAlongNormal / invMassSum;
          sphere.velocity.add(Vec3.scale(normal, impulseMag / sphere.mass));
          box.velocity.add(Vec3.scale(normal, -impulseMag / box.mass));
        } else if (!sphereStatic && boxStatic) {
          sphere.velocity.add(Vec3.scale(normal, -(1 + e) * velAlongNormal));
        } else if (sphereStatic && !boxStatic) {
          box.velocity.add(Vec3.scale(normal, (1 + e) * velAlongNormal));
        }
      }
    }
  }

  private collideBoxParticle(box: Box, particle: Particle): void {
    if (particle.pinned) return;

    const closestPoint = new Vec3(
      Math.max(box.position.x - box.halfExtents.x, Math.min(particle.position.x, box.position.x + box.halfExtents.x)),
      Math.max(box.position.y - box.halfExtents.y, Math.min(particle.position.y, box.position.y + box.halfExtents.y)),
      Math.max(box.position.z - box.halfExtents.z, Math.min(particle.position.z, box.position.z + box.halfExtents.z))
    );

    const delta = Vec3.sub(particle.position, closestPoint);
    const dist = delta.length();

    if (dist < 0.01) {
      let normal: Vec3;
      if (dist < 1e-6) {
        normal = new Vec3(0, 1, 0);
      } else {
        normal = delta.copy().normalize();
      }

      const overlap = 0.01 - dist;
      particle.position.add(Vec3.scale(normal, overlap + 0.001));

      const relVel = particle.velocity;
      const velAlongNormal = relVel.dot(normal);

      if (velAlongNormal < 0) {
        const e = 0.1;
        particle.velocity.add(Vec3.scale(normal, -velAlongNormal * (1 + e)));
      }
    }
  }
}
