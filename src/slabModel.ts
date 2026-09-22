import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/**
 * Loads the pruned wyrmslate GLB (public/models/wyrmslate.glb) containing only
 * the inner graded-card brick: clear shell, frost mat, label plane and card
 * plane. The label/card planes carry the author's UVs into an atlas whose
 * layout matches the original Blaze.jpg, so the engine can draw any card into
 * the same template.
 */

/** Inner card brick only; everything else was pruned out of the GLB. */
const KEEP = new Set([
  "Glass_Card003",
  "GLASS_FROST",
  "Glass_Card003_1",
  "Glass_Card003_4",
]);

export interface SlabModelPart {
  name: string;
  geometry: THREE.BufferGeometry;
  materials: string[];
}

const ATTRS = ["position", "normal", "uv"] as const;

/** FBX2glTF converts cm to m; the engine's slab constants use FBX units. */
const FBX_UNITS = 100;

function cleanGeometry(mesh: THREE.Mesh): THREE.BufferGeometry {
  const geometry = mesh.geometry.clone();
  geometry.applyMatrix4(mesh.matrixWorld);
  geometry.scale(FBX_UNITS, FBX_UNITS, FBX_UNITS);
  for (const name of Object.keys(geometry.attributes)) {
    if (!(ATTRS as readonly string[]).includes(name)) geometry.deleteAttribute(name);
  }
  if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
  // glTF UVs assume flipY=false textures; the engine uses default (flipY=true)
  // canvas textures, so mirror V back to the FBX/three convention.
  const uv = geometry.getAttribute("uv");
  if (uv) {
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    uv.needsUpdate = true;
  }
  return geometry;
}

/** Geometry is returned baked to world space, sized/centred by the caller. */
export async function loadSlabModel(url = "assets/wyrmslate.glb"): Promise<SlabModelPart[]> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  root.updateWorldMatrix(true, true);

  const parts: SlabModelPart[] = [];
  for (const name of KEEP) {
    const node = root.getObjectByName(name);
    if (!node) continue;
    // Multi-primitive glTF meshes load as a Group of one Mesh per material.
    const prims: THREE.Mesh[] = [];
    if ((node as THREE.Mesh).isMesh) prims.push(node as THREE.Mesh);
    else node.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) prims.push(obj as THREE.Mesh);
    });
    if (prims.length === 0) continue;

    const geometries = prims.map(cleanGeometry);
    const merged = prims.length === 1 ? geometries[0] : mergeGeometries(geometries, true);
    if (!merged) continue;
    if (prims.length > 1) for (const g of geometries) g.dispose();

    const materials = prims.map((p) => {
      const mat = Array.isArray(p.material) ? p.material[0] : p.material;
      return mat?.name ?? "";
    });
    parts.push({ name, geometry: merged, materials });
  }

  // Free the loader's own resources — the engine assigns its own materials.
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) m?.dispose();
  });

  return parts;
}
