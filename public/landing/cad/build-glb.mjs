import fs from 'node:fs/promises';
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

globalThis.FileReader ??= class FileReader {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = value;
      this.onloadend?.();
    });
  }
  readAsDataURL(blob) {
    blob.arrayBuffer().then((value) => {
      this.result = `data:${blob.type};base64,${Buffer.from(value).toString('base64')}`;
      this.onloadend?.();
    });
  }
};

const loader = new STLLoader();
const output = new URL('./output/taptime-solid-case.glb', import.meta.url);
const readArrayBuffer = async (url) => {
  const data = await fs.readFile(url);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};
const frontGeometry = loader.parse(await readArrayBuffer(new URL('./output/taptime-front-case.stl', import.meta.url)));
const rearGeometry = loader.parse(await readArrayBuffer(new URL('./output/taptime-rear-case.stl', import.meta.url)));
frontGeometry.computeVertexNormals();
rearGeometry.computeVertexNormals();

const front = new THREE.Mesh(frontGeometry, new THREE.MeshStandardMaterial({
  name: 'TapTime teal case', color: 0x078f98, roughness: 0.48, metalness: 0.04
}));
front.name = 'Front case — 11 mm';
front.rotation.x = Math.PI;
front.position.z = 17;

const rear = new THREE.Mesh(rearGeometry, new THREE.MeshStandardMaterial({
  name: 'Warm white rear case', color: 0xe8e7df, roughness: 0.7, metalness: 0
}));
rear.name = 'Rear case — 6 mm';

const nfc = new THREE.Mesh(
  new THREE.CylinderGeometry(12.5, 12.5, 0.7, 64),
  new THREE.MeshStandardMaterial({ name: 'Enclosed NFC insert', color: 0xf3b94d, roughness: 0.55, metalness: 0.08 })
);
nfc.name = '25 mm NFC insert';
nfc.rotation.x = Math.PI / 2;
nfc.position.z = 13.1;

const assembly = new THREE.Group();
assembly.name = 'TapTime solid NFC case';
assembly.add(rear, nfc, front);
assembly.rotation.x = -Math.PI / 2;
assembly.position.y = -8.5;

const scene = new THREE.Scene();
scene.name = 'TapTime case assembly';
scene.add(assembly);

const exporter = new GLTFExporter();
const arrayBuffer = await exporter.parseAsync(scene, {
  binary: true,
  trs: false,
  onlyVisible: true,
  includeCustomExtensions: false
});
await fs.writeFile(output, Buffer.from(arrayBuffer));
console.log(`Created ${output.pathname}`);
