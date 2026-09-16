import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { getExample } from "../../lib/examples";

async function expectInstructionsBelowScene(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const canvas = document.querySelector(".scene-viewport canvas")?.getBoundingClientRect();
    const caption = document.querySelector(".tutorial-player > .scene-caption")?.getBoundingClientRect();
    return !!canvas && !!caption && caption.top >= canvas.bottom - 1;
  })).toBe(true);
}

test("loads an animated GLB, keeps camera controls live, and reviews publication text", async ({ page }) => {
  test.setTimeout(90_000);
  const id = "11111111-1111-4111-8111-111111111111";
  const tutorial = {...getExample("example-espresso")!, id, ownerId:"owner-test", isExample:false, visibility:"private", scene:{
    version:1, units:"meters", durationSeconds:10,
    assets:[{path:"test/scene.glb",kind:"scene",url:"/fixture-scene.glb"},{path:"test/detail.glb",kind:"detail",url:"/fixture-detail.glb"}],
    cameras:{first:{position:[0,1.6,1],target:[0,1.1,0]},third:{position:[2,2,3],target:[0,1,0]}},
    bounds:{min:[-3,0,-3],max:[3,3,3]},landmarks:[],objects:[],
    steps:[{stepId:"prepare",startTime:0,endTime:10,clipName:"tutorial"}],
    rig:{bodyNode:"TutorBody",handNodes:["TutorHand_L","TutorHand_R"]},
    quality:{approved:true,registeredFrameRatio:1,medianReprojectionError:.2,measurementErrors:[.01],notes:[]},sanitized:false,
  }};
  tutorial.scene.steps[0].stepId=tutorial.plan!.steps[0].id;
  const errors: string[]=[]; page.on("pageerror", e=>errors.push(e.message));
  await page.route("**/api/config", route=>route.fulfill({json:{configured:true,services:{database:true,openai:true,worker:true},user:{id:"owner-test"}}}));
  await page.route(`**/api/tutorials/${id}`, route=>route.fulfill({json:{tutorial}}));
  await page.route(`**/api/tutorials/${id}/publish`, route=>route.fulfill({json:{preview:{...tutorial,goal:"Public goal for review",scene:{...tutorial.scene,sanitized:true,assets:[{kind:"sanitized_scene",path:"test/public.glb",url:"/fixture-scene.glb"}]}},requiresConfirmation:true}}));
  let releaseScene!: () => void;
  const sceneGate = new Promise<void>(resolve => { releaseScene = resolve; });
  await page.route("**/fixture-*.glb", async route => {
    await sceneGate;
    await route.fulfill({path:path.join(process.cwd(),"tests/fixtures/animated-scene.glb"),contentType:"model/gltf-binary"});
  });
  await page.goto(`/tutorial/${id}/your-everyday-espresso`);
  await expect(page.getByRole("button",{name:"Play tutorial",exact:true})).toBeDisabled();
  await expect(page.getByRole("slider",{name:"Tutorial timeline"})).toHaveValue("0");
  releaseScene();
  await expect(page.getByRole("button",{name:"Play tutorial",exact:true})).toBeEnabled();
  await expectInstructionsBelowScene(page);
  if (await page.evaluate(() => document.fullscreenEnabled)) {
    await page.getByRole("button",{name:"Fullscreen tutorial",exact:true}).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.className)).toBe("tutorial-player");
    await expectInstructionsBelowScene(page);
    await expect.poll(() => page.evaluate(() => {
      const caption = document.querySelector(".tutorial-player > .scene-caption")?.getBoundingClientRect();
      const controls = document.querySelector(".tutorial-player > .player-transport")?.getBoundingClientRect();
      return !!caption && !!controls && caption.height > 0 && controls.height > 0 &&
        caption.top >= 0 && caption.bottom <= innerHeight + 1 &&
        controls.top >= caption.bottom - 1 && controls.bottom <= innerHeight + 1;
    })).toBe(true);
    await page.getByRole("button",{name:"Fullscreen tutorial",exact:true}).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await expectInstructionsBelowScene(page);
  }
  await expect(page.getByRole("button",{name:"More detail",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"More detail",exact:true}).click();
  await expect(page.getByRole("button",{name:"Use mobile detail",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"First person",exact:true}).click();
  await page.getByRole("button",{name:"Play tutorial",exact:true}).click();
  await expect(page.getByRole("slider",{name:"Tutorial timeline"})).not.toHaveValue("0");
  await page.getByRole("button",{name:"Share",exact:true}).click();
  await expect(page.getByRole("dialog",{name:"Share tutorial"})).toBeVisible();
  await page.getByRole("button",{name:"Prepare sharing preview",exact:true}).click();
  await expect(page.getByRole("dialog").getByText("Public goal for review",{exact:false})).toBeVisible();
  await page.getByText("Review every public step",{exact:true}).click();
  await expect(page.getByRole("dialog").getByText(tutorial.plan!.steps[0].title,{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"Publish task-area tutorial",exact:true})).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog",{name:"Share tutorial"})).not.toBeVisible();
  expect(errors).toEqual([]);
});
