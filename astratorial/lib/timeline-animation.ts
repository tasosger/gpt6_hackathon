import { AnimationMixer, LoopOnce, type AnimationClip, type Object3D } from "three";

/** Evaluate saved animation at an absolute tutorial time, including its final pose. */
export function createTimelineAnimation(root: Object3D, clips: AnimationClip[]) {
  const mixer = new AnimationMixer(root);
  const actions = clips.map(clip => {
    const action = mixer.clipAction(clip);
    action.setLoop(LoopOnce, 1);
    action.clampWhenFinished = true;
    return action.play();
  });

  return {
    seek(time: number) {
      // Finishing a clamped action pauses it. Reset before absolute evaluation so
      // seeking backward or replaying after the end cannot leave the model frozen.
      for (const action of actions) action.reset().play();
      mixer.setTime(Math.max(0, time));
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(root);
    },
  };
}
