import * as THREE from 'three';
import { createSpheresScene, createBoxStackScene, createClothScene, createThreeBodyScene } from './scenes';
import { Sphere, Box, Particle, World, Vec3 } from './physics';

let threeBodyPreset: 'small' | 'large' = 'small';

const scenes = [
  { name: 'Bouncing Spheres', factory: createSpheresScene },
  { name: 'Box Stack', factory: createBoxStackScene },
  { name: 'Cloth', factory: createClothScene },
  { name: 'Three Bodies', factory: () => createThreeBodyScene(threeBodyPreset) },
];

let currentSceneIndex = 0;
let timeScale = 1;
let panelUpdaters: { [key: string]: (value: any) => void } = {};

interface SceneObject {
  world: World;
  meshes: Map<any, THREE.Object3D>;
  cloth?: THREE.BufferGeometry;
  clothMesh?: THREE.Mesh;
  trails?: Map<any, Vec3[]>;
  trailMeshes?: Map<any, THREE.Line>;
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
  let trails: Map<any, Vec3[]> | undefined;
  let trailMeshes: Map<any, THREE.Line> | undefined;

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

  if (index === 3) {
    trails = new Map();
    trailMeshes = new Map();
    for (const body of world.bodies) {
      if (body instanceof Sphere) {
        trails.set(body, []);
        const geometry = new THREE.BufferGeometry();
        const material = new THREE.LineBasicMaterial({ color: 0x00ff88, transparent: true });
        const line = new THREE.Line(geometry, material);
        scene.add(line);
        trailMeshes.set(body, line);
      }
    }
  }

  return { world, meshes, cloth, clothMesh, trails, trailMeshes };
}

function addSlider(
  panel: HTMLElement,
  name: string,
  min: number,
  max: number,
  initial: number,
  onChange: (v: number) => void
) {
  const container = document.createElement('div');
  container.style.marginBottom = '8px';

  const label = document.createElement('label');
  label.textContent = `${name}: `;
  label.style.display = 'inline-block';
  label.style.width = '90px';

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = '0.01';
  input.value = String(initial);
  input.style.width = '80px';

  const valueDisplay = document.createElement('span');
  valueDisplay.textContent = initial.toFixed(2);
  valueDisplay.style.marginLeft = '5px';
  valueDisplay.style.width = '45px';
  valueDisplay.style.display = 'inline-block';

  const onInputChange = (e: Event) => {
    const value = parseFloat((e.target as HTMLInputElement).value);
    onChange(value);
    valueDisplay.textContent = value.toFixed(2);
  };

  input.addEventListener('input', onInputChange);

  panelUpdaters[name] = onChange;

  container.appendChild(label);
  container.appendChild(input);
  container.appendChild(valueDisplay);
  panel.appendChild(container);
}

function addButton(panel: HTMLElement, name: string, onClick: () => void) {
  const button = document.createElement('button');
  button.textContent = name;
  button.style.cssText = `
    margin: 5px 5px 5px 0;
    padding: 5px 10px;
    background: #00ff88;
    border: 1px solid #00ff88;
    color: #1a1a2e;
    font-family: monospace;
    cursor: pointer;
    font-size: 11px;
    border-radius: 2px;
  `;
  button.addEventListener('click', onClick);
  panel.appendChild(button);
}

function buildPanel(sceneIndex: number) {
  let panel = document.querySelector('[data-physics-panel]') as HTMLElement;
  const isNewPanel = !panel;

  if (!panel) {
    panel = document.createElement('div');
    panel.setAttribute('data-physics-panel', 'true');
    panel.style.cssText = `
      position: absolute;
      top: 60px;
      left: 10px;
      background: rgba(26, 26, 46, 0.95);
      border: 1px solid #00ff88;
      border-radius: 4px;
      padding: 10px;
      color: #00ff88;
      font-family: monospace;
      font-size: 11px;
      pointer-events: auto;
      z-index: 100;
      user-select: none;
    `;
  } else {
    panel.innerHTML = '';
  }

  panelUpdaters = {};

  if (sceneIndex === 0) {
    addSlider(panel, 'gravity', -20, -1, -9.81, (v) => {
      sceneObject.world.gravity.y = v;
    });
    addSlider(panel, 'restitution', 0, 1, 0.8, (v) => {
      for (const body of sceneObject.world.bodies) {
        if (body.mass > 0) body.restitution = v;
      }
    });
  } else if (sceneIndex === 1) {
    addSlider(panel, 'gravity', -20, -1, -9.81, (v) => {
      sceneObject.world.gravity.y = v;
    });
    addSlider(panel, 'restitution', 0, 1, 0.3, (v) => {
      for (const body of sceneObject.world.bodies) {
        if (body.mass > 0) body.restitution = v;
      }
    });
  } else if (sceneIndex === 2) {
    addSlider(panel, 'gravity', -20, -1, -9.81, (v) => {
      sceneObject.world.gravity.y = v;
    });
    addSlider(panel, 'stiffness', 100, 1000, 500, (v) => {
      for (const spring of sceneObject.world.springs) {
        spring.stiffness = v;
      }
    });
    addSlider(panel, 'damping', 0, 30, 15, (v) => {
      for (const spring of sceneObject.world.springs) {
        spring.damping = v;
      }
    });
  } else if (sceneIndex === 3) {
    const currentG = sceneObject.world.gravitationalConstant;
    addSlider(panel, 'G', 1, 200, currentG, (v) => {
      sceneObject.world.gravitationalConstant = v;
    });
    const presetContainer = document.createElement('div');
    presetContainer.style.marginBottom = '8px';
    addButton(presetContainer, 'Preset: Small', () => {
      threeBodyPreset = 'small';
      loadScene(3);
    });
    addButton(presetContainer, 'Preset: Large', () => {
      threeBodyPreset = 'large';
      loadScene(3);
    });
    panel.appendChild(presetContainer);
  }

  addSlider(panel, 'timeScale', 0, 2, 1, (v) => {
    timeScale = v;
  });

  if (isNewPanel) {
    document.body.appendChild(panel);
  }
}

function loadScene(index: number) {
  currentSceneIndex = index % scenes.length;
  sceneObject = createSceneObject(currentSceneIndex);
  const sceneNameEl = document.querySelector('#scene-name');
  if (sceneNameEl) {
    sceneNameEl.textContent = scenes[currentSceneIndex].name;
  }
  timeScale = 1;
  buildPanel(currentSceneIndex);
}

loadScene(0);

function updateScene() {
  sceneObject.world.step((1 / 60) * timeScale);

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

  if (sceneObject.trails && sceneObject.trailMeshes) {
    const maxTrailLength = 60;
    for (const [body, trailLine] of sceneObject.trailMeshes) {
      const trail = sceneObject.trails.get(body);
      if (trail) {
        trail.push(body.position.copy());
        if (trail.length > maxTrailLength) {
          trail.shift();
        }
        const positions: number[] = [];
        for (const pos of trail) {
          positions.push(pos.x, pos.y, pos.z);
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        trailLine.geometry.dispose();
        trailLine.geometry = geometry;
        const material = trailLine.material as THREE.LineBasicMaterial;
        if (trail.length > 0) {
          material.opacity = Math.min(1, trail.length / 20);
        }
      }
    }
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
    __physicsSetParam: (name: string, value: any) => void;
  }
}

window.__physicsSample = () => {
  const result: number[] = [];
  for (const body of sceneObject.world.bodies) {
    result.push(body.position.x, body.position.y, body.position.z);
  }
  return result;
};

window.__physicsSetParam = (name: string, value: any) => {
  if (name === 'timeScale') {
    timeScale = value;
  } else if (panelUpdaters[name]) {
    panelUpdaters[name](value);
  }
};
