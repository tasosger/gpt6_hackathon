import PracticeWorkspace from "@/components/player/practice-workspace";
import "@/components/player/player.css";

export default async function PracticePage({ params }: { params: Promise<{ id: string; slug: string }> }) {
  const { id } = await params;
  return <PracticeWorkspace key={id} id={id} />;
}
