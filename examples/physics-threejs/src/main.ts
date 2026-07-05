import * as THREE from 'three';
import { createSpheresScene, createBoxStackScene, createClothScene } from './scenes';
import { Sphere, Box, Particle, World } from './physics';

const scenes = [
  { name: 'Bouncing Spheres', factory: createSpheresScene },
  { name: 'Box Stack', factory: createBoxStackScene },
  { name: 'Cloth', factory: createClothScene },
];

let currentSceneIndex = 0;

interface SceneObject {
  world: World;
  meshes: Map<any, THREE.Object3D>;
  cloth?: THREE.BufferGeometry;
  clothMesh?: THREE.Mesh;
}

let sceneObject: SceneObject = {
  world: new World(),
  meshes: new Map(),
};

const canvas = document.querySelector('canvas')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x1a1a2e);

const camera = new THREE.PerspectiveCamera(
  75,
  window.innerWidth / window.innerHeight,
  0.1,
  1000
);
camera.position.set(0, 5, 15);
camera.lookAt(0, 0, 0);

const scene = new THREE.Scene();

const light = new THREE.DirectionalLight(0xffffff, 0.8);
light.position.set(10, 20, 10);
scene.add(light);

const ambient = new THREE.AmbientLight(0xffffff, 0.4);
scene.add(ambient);

function createSceneObject(index: number): SceneObject {
  while (scene.children.length > 2) {
    scene.remove(scene.children[2]);
  }

  const factory = scenes[index].factory;
  const world = factory();
  const meshes = new Map();

  for (const body of world.bodies) {
    if (body instanceof Sphere) {
      const geometry = new THREE.SphereGeometry(body.radius, 32, 32);
      const material = new THREE.MeshPhongMaterial({ color: 0x00ff88 });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(body.position as any);
      scene.add(mesh);
      meshes.set(body, mesh);
    } else if (body instanceof Box) {
      const geometry = new THREE.BoxGeometry(
        body.halfExtents.x * 2,
        body.halfExtents.y * 2,
        body.halfExtents.z * 2
      );
      const color = body.mass === 0 ? 0x888888 : 0xff6b6b;
      const material = new THREE.MeshPhongMaterial({ color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(body.position as any);
      scene.add(mesh);
      meshes.set(body, mesh);
    } else if (body instanceof Particle) {
      const geometry = new THREE.SphereGeometry(0.1, 16, 16);
      const color = body.pinned ? 0xffff00 : 0x00ccff;
      const material = new THREE.MeshPhongMaterial({ color });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.copy(body.position as any);
      scene.add(mesh);
      meshes.set(body, mesh);
    }
  }

  let cloth: THREE.BufferGeometry | undefined;
  let clothMesh: THREE.Mesh | undefined;

  if (index === 2) {
    cloth = new THREE.BufferGeometry();
    const positions: number[] = [];
    const indices: number[] = [];

    for (const body of world.bodies) {
      if (body instanceof Particle) {
        positions.push(body.position.x, body.position.y, body.position.z);
      }
    }

    cloth.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));

    const segmentsX = 6;
    const segmentsY = 5;
    for (let y = 0; y < segmentsY; y++) {
      for (let x = 0; x < segmentsX; x++) {
        const a = y * (segmentsX + 1) + x;
        const b = a + 1;
        const c = a + (segmentsX + 1);
        const d = c + 1;

        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    cloth.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    cloth.computeVertexNormals();

    const material = new THREE.MeshPhongMaterial({
      color: 0x4488ff,
      side: THREE.DoubleSide,
      wireframe: false,
    });
    clothMesh = new THREE.Mesh(cloth, material);
    scene.add(clothMesh);
  }

  return { world, meshes, cloth, clothMesh };
}

function loadScene(index: number) {
  currentSceneIndex = index % scenes.length;
  sceneObject = createSceneObject(currentSceneIndex);
  const sceneNameEl = document.querySelector('#scene-name');
  if (sceneNameEl) {
    sceneNameEl.textContent = scenes[currentSceneIndex].name;
  }
}

loadScene(0);

function updateScene() {
  sceneObject.world.step(1 / 60);

  for (const [body, mesh] of sceneObject.meshes) {
    mesh.position.copy(body.position as any);
  }

  if (sceneObject.cloth && sceneObject.clothMesh) {
    const particles = sceneObject.world.bodies.filter((b) => b instanceof Particle);
    const positions = (sceneObject.cloth.attributes.position as THREE.BufferAttribute).array as Float32Array;
    let idx = 0;
    for (const p of particles) {
      if (p instanceof Particle) {
        positions[idx++] = p.position.x;
        positions[idx++] = p.position.y;
        positions[idx++] = p.position.z;
      }
    }
    (sceneObject.cloth.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    sceneObject.cloth.computeVertexNormals();
  }
}

function render() {
  updateScene();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

function onWindowResize() {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}

window.addEventListener('resize', onWindowResize);

document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight' || e.key === ' ') {
    loadScene(currentSceneIndex + 1);
  } else if (e.key === 'ArrowLeft') {
    loadScene(currentSceneIndex - 1);
  }
});

render();

declare global {
  interface Window {
    __physicsSample: () => number[];
  }
}

window.__physicsSample = () => {
  const result: number[] = [];
  for (const body of sceneObject.world.bodies) {
    result.push(body.position.x, body.position.y, body.position.z);
  }
  return result;
};
