import TutorialWorkspace from "@/components/player/tutorial-workspace";
import "@/components/player/player.css";

export default async function TutorialPage({ params }: { params: Promise<{ id: string; slug: string }> }) {
  const { id } = await params;
  return <TutorialWorkspace key={id} id={id} />;
}
