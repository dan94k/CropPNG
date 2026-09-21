import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { selectConnected, detectComponents, removeCornerBackground, makeZip, crc32, safeName } from '../dist/core.mjs';
function pixels(w, h, fill = [0, 0, 0, 0]) { const a = new Uint8ClampedArray(w*h*4); for(let p=0;p<w*h;p++) a.set(fill,p*4); return a; }
function pixel(a, w, x, y, color) { a.set(color,(y*w+x)*4); }
test('alpha components keep multicolor and diagonal-connected sprites, isolate neighbors',()=>{
 const data=pixels(8,6); for(let y=0;y<3;y++) for(let x=0;x<2;x++) pixel(data,8,x,y,[x*255,y*80,0,255]);
 pixel(data,8,2,3,[50,100,255,128]); for(let y=1;y<4;y++) for(let x=5;x<7;x++) pixel(data,8,x,y,[255,255,255,255]);
 const result=detectComponents(data,8,6,1); assert.equal(result.components.length,2); assert.equal(result.components[0].pixels,7); assert.equal(result.components[1].pixels,6);
 assert.deepEqual(selectConnected(data,8,6,0,0,1,true),result.components[0]); assert.equal(selectConnected(data,8,6,4,4),null);
});
test('opaque input does not pretend to detect semantic objects',()=>{ assert.equal(detectComponents(pixels(4,4,[5,5,5,255]),4,4).opaque,true); });
test('color flood fill uses fixed seed and respects width edges',()=>{
 const data=pixels(5,2,[200,200,200,255]); for(let x=0;x<5;x++) pixel(data,5,x,0,[x*20,x*20,x*20,255]);
 const selection=selectConnected(data,5,2,0,0,25,false); assert.equal(selection.pixels,2); assert.equal(selection.w,2);
 const edge=pixels(3,2,[200,0,0,255]); pixel(edge,3,2,0,[0,0,0,255]);pixel(edge,3,0,1,[0,0,0,255]); assert.equal(selectConnected(edge,3,2,2,0,5).pixels,1);
});
test('corner removal preserves object, enclosed background holes, and original RGB',()=>{
 const data=pixels(7,7,[255,255,255,255]); for(let y=2;y<=4;y++) for(let x=2;x<=4;x++) pixel(data,7,x,y,[200,0,0,255]); pixel(data,7,3,3,[255,255,255,255]);
 removeCornerBackground(data,7,7,10); assert.equal(data[3],0); assert.equal(data[(2*7+2)*4+3],255); assert.equal(data[(3*7+3)*4+3],255); assert.equal(data[0],255);
});
test('ZIP has correct CRC and exports duplicate-safe sanitized names',async()=>{
 assert.equal(crc32(new TextEncoder().encode('123456789')),0xcbf43926); assert.equal(safeName('../ouro ç.png'),'ouro_c_png');
 const blob=makeZip([{name:'gold.png',bytes:new Uint8Array([1,2,3])},{name:'diamante.png',bytes:new Uint8Array([4,5,6,7])}]); await writeFile('/tmp/croppng-test.zip',new Uint8Array(await blob.arrayBuffer()));
});
