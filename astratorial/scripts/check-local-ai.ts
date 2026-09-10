/** Opt-in API smoke test with an explicitly illustrative fixture, no Supabase state. */
import { loadEnvConfig } from '@next/env';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PLAN_INSTRUCTIONS,SCENE_INSTRUCTIONS,validatePlanIds } from '../lib/local/pipeline';
import { TutorialPlanSchema } from '../lib/contracts';
import { IllustrationSchema,validateIllustration,buildIllustratedScene,exportGlb } from '../lib/local/scene';
import { renderIllustration } from '../lib/local/render';
loadEnvConfig(process.cwd());
async function main(){
  if(!process.argv.includes('--paid'))throw new Error('This smoke test makes bounded paid OpenAI calls. Run with --paid to explicitly enable them.');
  const ai=new OpenAI({apiKey:process.env.OPENAI_API_KEY,maxRetries:0,timeout:180000});
  const directory=resolve('../outputs/local-ai');await mkdir(directory,{recursive:true});
  const bytes=await readFile('public/images/cooking.png');
  const content={type:'input_image' as const,image_url:`data:image/png;base64,${bytes.toString('base64')}`,detail:'low' as const};
  const result=await ai.responses.parse({model:process.env.OPENAI_MODEL||'gpt-6-astra',store:false,max_output_tokens:7000,reasoning:{effort:'low'},instructions:PLAN_INSTRUCTIONS,input:[{role:'user',content:[{type:'input_text',text:'No goal has been entered. Infer the most likely task from this synthetic test image. This is a fixture, not real user footage. Do not invent external sources; there is no web search in this isolated smoke test.'},content]}],text:{format:zodTextFormat(TutorialPlanSchema,'tutorial_plan')}});
  if(!result.output_parsed)throw new Error('No plan');const plan=result.output_parsed;validatePlanIds(plan);await writeFile(resolve(directory,'plan.json'),JSON.stringify(plan,null,2));
  console.log(JSON.stringify({title:plan.title,goal:plan.goal,steps:plan.steps.length,questions:plan.questions.length,usage:result.usage}));
  const scene=await ai.responses.parse({model:process.env.OPENAI_MODEL||'gpt-6-astra',store:false,max_output_tokens:14000,reasoning:{effort:'low'},instructions:SCENE_INSTRUCTIONS,input:[{role:'user',content:[{type:'input_text',text:JSON.stringify({plan})},content]}],text:{format:zodTextFormat(IllustrationSchema,'tutorial_illustration')}});
  const illustration=validateIllustration(plan,scene.output_parsed);await writeFile(resolve(directory,'illustration.json'),JSON.stringify(illustration,null,2));
  const built=buildIllustratedScene(plan,illustration);const glb=await exportGlb(built.scene,built.clip);const file=resolve(directory,'scene.glb');await writeFile(file,glb);await writeFile(resolve(directory,'manifest.json'),JSON.stringify(built.manifest,null,2));
  const output=await renderIllustration(file,built.manifest,directory,false);console.log(JSON.stringify({objects:illustration.objects.length,glbBytes:glb.length,poster:output.poster,usage:scene.usage}));
  const speech=await ai.audio.speech.create({model:process.env.OPENAI_TTS_MODEL||'gpt-4o-mini-tts',voice:'marin',input:plan.steps[0].narration.slice(0,600),response_format:'wav',instructions:'Warm, clear household tutorial guidance.'});await writeFile(resolve(directory,'narration.wav'),Buffer.from(await speech.arrayBuffer()));
  console.log('Narration API verified; audio saved. Fixture smoke test finished.');
}
main().catch(error=>{console.error(error instanceof OpenAI.APIError?`OpenAI ${error.status}: ${error.code||'request failed'}`:error.message);process.exitCode=1;});
