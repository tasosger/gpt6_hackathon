/** Local deterministic renderer smoke test; no API requests or user media. */
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildIllustratedScene,exportGlb,type Illustration } from '../lib/local/scene';
import { renderIllustration } from '../lib/local/render';
import { examples } from '../lib/examples';
async function main(){
  const directory=resolve('../outputs/local-render');await mkdir(directory,{recursive:true});
  const original=examples[0].plan!;
  const plan={...original,objects:[{id:'cup',name:'Cup',kind:'vessel',observed:true,notes:''}],steps:[{...original.steps[0],id:'place',action:'move' as const,objectIds:['cup'],durationSeconds:5}]};
  const scene:Illustration={surface:{width:1.2,depth:.7,color:'#ded8c9'},objects:[{id:'cup',position:{x:-.2,y:0,z:0},movable:true,parts:[{shape:'cylinder',position:{x:0,y:.06,z:0},size:{x:.09,y:.12,z:.09},rotation:{x:0,y:0,z:0},color:'#dd724e',metallic:false},{shape:'torus',position:{x:.055,y:.06,z:0},size:{x:.07,y:.014,z:.02},rotation:{x:0,y:0,z:0},color:'#dd724e',metallic:false}]}],gestures:[{stepId:'place',objectId:'cup',hand:'right',contact:{x:-.14,y:.08,z:0},endPosition:{x:.2,y:0,z:.1},endRotation:null}],uncertainty:['Illustrated test scene']};
  const built=buildIllustratedScene(plan,scene);const file=resolve(directory,'scene.glb');await writeFile(file,await exportGlb(built.scene,built.clip));
  const output=await renderIllustration(file,built.manifest,directory,true);console.log(output);
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
