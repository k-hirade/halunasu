import { ExamWorkbench } from "../../../../components/exam-workbench";

export default async function EncounterExamPage({ params }) {
  const { id } = await params;
  return <ExamWorkbench encounterId={id} />;
}
