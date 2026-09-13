import fs from 'node:fs/promises';
import path from 'node:path';
import modeling from '@jscad/modeling';
import { serialize } from '@jscad/stl-serializer';

const { primitives, booleans, transforms, extrusions, text, geometries } = modeling;
const { roundedRectangle, cylinder, cuboid } = primitives;
const { subtract, union } = booleans;
const { translate, mirrorY } = transforms;
const { extrudeLinear, extrudeRectangular } = extrusions;
const { vectorText } = text;
const { path2 } = geometries;
const out = new URL('./output/', import.meta.url);

const move = (xyz, shape) => translate(xyz, shape);
const roundedPrism = (size, radius, centerZ) => move([0,0,centerZ-size[2]/2], extrudeLinear({height:size[2]}, roundedRectangle({size:[size[0],size[1]],roundRadius:radius,segments:48})));
const pegPositions = [[-21.5,-21.5],[-21.5,21.5],[21.5,-21.5],[21.5,21.5]];

const outer = roundedPrism([56,56,11],9,5.5);
const inner = roundedPrism([50,50,8.1],6,7.05);
const sockets = pegPositions.map(([x,y]) => cylinder({radius:1.75,height:5.8,segments:36,center:[x,y,8.4]}));
const brandSegments = vectorText({height:3.4,letterSpacing:1.06},'TAPTIME');
const brandPoints = brandSegments.flat();
const brandCenterX = (Math.min(...brandPoints.map(([x])=>x))+Math.max(...brandPoints.map(([x])=>x)))/2;
const brandCenterY = (Math.min(...brandPoints.map(([,y])=>y))+Math.max(...brandPoints.map(([,y])=>y)))/2;
const brandStrokes = brandSegments.map((segment)=>extrudeRectangular({size:0.45,height:0.75,segments:12,corners:'round'},path2.fromPoints({closed:false},segment)));
const centeredBrand = move([-brandCenterX,-brandCenterY,-0.1],union(...brandStrokes));
// The front case prints face-down and is flipped for use; pre-flip Y so the
// finished wordmark reads normally from the outside.
const brandMark = mirrorY(centeredBrand);
const cradleOuter = cylinder({radius:15,height:1.8,segments:72,center:[0,0,3.9]});
const cradleInner = cylinder({radius:12.8,height:2,segments:72,center:[0,0,3.9]});
const front = union(subtract(outer,inner,brandMark,...sockets),subtract(cradleOuter,cradleInner));

const rearBase = roundedPrism([56,56,6],9,3);
const locatingLip = roundedPrism([49.5,49.5,2],5.75,7);
const pegs = pegPositions.map(([x,y]) => cylinder({radius:1.5,height:4.1,segments:36,center:[x,y,8.05]}));
let rear = union(rearBase,locatingLip,...pegs);
const screwHoles = [-16,16].flatMap((y) => [
  cylinder({radius:2.1,height:8.4,segments:48,center:[0,y,4]}),
  cylinder({radiusStart:4.1,radiusEnd:2.1,height:2.4,segments:48,center:[0,y,1.2]})
]);
const magnetPockets = [-16,16].map((x) => cylinder({radius:7.7,height:3.2,segments:64,center:[x,0,2.4]}));
const notch = cuboid({size:[13,7,4],center:[0,-28,5]});
rear = subtract(rear,...screwHoles,...magnetPockets,notch);

await fs.mkdir(out,{recursive:true});
for (const [name,solid] of [['taptime-front-case.stl',front],['taptime-rear-case.stl',rear]]) {
  await fs.writeFile(new URL(name,out),serialize({binary:false},solid).join(''));
}
console.log(`Created solid-case STL files in ${path.resolve('cad/output')}`);
