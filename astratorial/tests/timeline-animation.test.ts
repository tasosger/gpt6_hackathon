import { describe, expect, it } from "vitest";
import { AnimationClip, Bone, Group, VectorKeyframeTrack } from "three";
import { createTimelineAnimation } from "../lib/timeline-animation";

function fixture() {
  const root = new Group();
  const hand = new Bone();
  hand.name = "Hand";
  root.add(hand);
  const clip = new AnimationClip("Tutorial", 4, [
    new VectorKeyframeTrack("Hand.position", [0, 2, 4], [0, 0, 0, 2, 1, 0, 4, 0, 0]),
  ]);
  return { hand, animation: createTimelineAnimation(root, [clip]) };
}

describe("tutorial animation timeline", () => {
  it("holds the final bone pose at and beyond the clip end", () => {
    const { hand, animation } = fixture();
    animation.seek(4);
    expect(hand.position.toArray()).toEqual([4, 0, 0]);
    animation.seek(6);
    expect(hand.position.toArray()).toEqual([4, 0, 0]);
    animation.dispose();
  });

  it("supports arbitrary backward and forward seeks after finishing", () => {
    const { hand, animation } = fixture();
    for (const [time, position] of [
      [4, [4, 0, 0]], [1, [1, .5, 0]], [3, [3, .5, 0]],
      [0, [0, 0, 0]], [4, [4, 0, 0]], [2, [2, 1, 0]],
    ] as const) {
      animation.seek(time);
      expect(hand.position.toArray()).toEqual(position);
    }
    animation.dispose();
  });
});
