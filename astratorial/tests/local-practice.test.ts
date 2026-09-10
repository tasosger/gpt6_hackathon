import { describe,it,expect } from 'vitest';
import { examples } from '../lib/examples';
import { applyPracticeAction,applyStepCheck,unconfirmedMovableObjects } from '../lib/server/practice';
import type { PracticeSession,Tutorial } from '../lib/contracts';
const tutorial:Tutorial={...examples[0],scene:{...examples[0].scene!,mode:'illustrated',landmarks:[]}};
const session:PracticeSession={id:'practice',tutorialId:tutorial.id,tutorialRevision:tutorial.revision,ownerId:'owner',currentStepIndex:0,version:0,status:'calibrating',completedStepIds:[],consecutiveComplete:0,calibration:null,createdAt:'now',updatedAt:'now'};
describe('illustrated practice',()=>{
  it('starts an explicitly approximate overlay without pretending to fit metric camera landmarks',()=>{const next=applyPracticeAction(session,tutorial,{action:'start_illustrated',version:0});expect(next.status).toBe('active');expect(next.calibration).toEqual({mode:'illustrated'});expect(unconfirmedMovableObjects(next,tutorial)).toEqual([]);expect(()=>applyPracticeAction(session,{...tutorial,scene:{...tutorial.scene!,mode:'measured'}},{action:'start_illustrated',version:0})).toThrow(/measured/);});
  it('preserves stale-check rejection and the two-observation completion rule',()=>{const observable={...tutorial,plan:{...tutorial.plan!,steps:tutorial.plan!.steps.map(step=>({...step,observable:true}))}};const next=applyPracticeAction(session,observable,{action:'start_illustrated',version:0});const check={stepId:observable.plan.steps[0].id,status:'complete' as const,evidence:'Visible task result',guidance:''};const once=applyStepCheck(next,observable,check,next.version);expect(once.currentStepIndex).toBe(0);expect(()=>applyStepCheck(once,observable,check,next.version)).toThrow(/changed/);const twice=applyStepCheck(once,observable,check,once.version);expect(twice.currentStepIndex).toBe(1);});
});
