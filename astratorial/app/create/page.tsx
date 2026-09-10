import { CreateWorkflow } from "@/components/capture/create-workflow";
export default async function CreatePage({ searchParams }: { searchParams: Promise<{ tutorial?: string; id?: string }> }) {
  const { tutorial, id } = await searchParams;
  return <CreateWorkflow key={tutorial ?? id ?? "new"} initialTutorialId={tutorial ?? id} />;
}
