import Image from "next/image";
import Link from "next/link";
import { tutorialHref, type Tutorial } from "@/lib/contracts";
import { Icon, type IconName } from "@/components/shell/icon";
export const categoryLabels = { coffee: "Coffee & rituals", cooking: "In the kitchen", assembly: "Make & mend", home: "Around the home" };
export const categoryIcons: Record<Tutorial["category"], IconName> = { coffee: "coffee", cooking: "cooking", assembly: "assembly", home: "home" };
export function CategoryChip({ category }: { category: Tutorial["category"] }) { return <span className={`category-chip category-${category}`}><Icon name={categoryIcons[category]} size={14} />{categoryLabels[category]}</span>; }
export function TutorialCard({ tutorial, priority = false }: { tutorial: Tutorial; priority?: boolean }) {
  return <Link className="tutorial-card" href={tutorial.status === "ready" ? tutorialHref(tutorial) : `/create?tutorial=${tutorial.id}`}>
    <div className={`tutorial-card-image image-${tutorial.category}`}>{tutorial.thumbnailUrl ? <Image src={tutorial.thumbnailUrl} alt="" fill sizes="(max-width: 650px) 90vw, (max-width: 1100px) 43vw, 28vw" priority={priority} unoptimized={tutorial.thumbnailUrl.startsWith("http")} /> : <div className="card-placeholder"><Icon name={categoryIcons[tutorial.category]} size={50} /></div>}<span className="image-label"><Icon name={tutorial.status === "ready" ? "box" : "file"} size={13} />{tutorial.isExample ? "Curated example" : tutorial.status === "ready" ? "Your 3D tutorial" : tutorial.status.replace("_", " ")}</span><span className="card-play"><Icon name={tutorial.status === "ready" ? "play" : "arrow"} size={18} /></span></div>
    <div className="tutorial-card-content"><CategoryChip category={tutorial.category} /><h3>{tutorial.title}</h3><p>{tutorial.description || tutorial.goal}</p><div className="card-meta"><span><Icon name="clock" size={14} />{tutorial.plan ? `${tutorial.plan.estimatedMinutes} min` : "Draft"}</span>{tutorial.plan && <><span className="meta-dot">·</span><span>{tutorial.plan.steps.length} steps</span><span className="difficulty"><i />{tutorial.plan.difficulty}</span></>}</div></div>
  </Link>;
}
